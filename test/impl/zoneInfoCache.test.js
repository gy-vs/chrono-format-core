/* global test expect describe beforeEach afterEach */
import { DateTime, IANAZone, Settings, SystemZone } from "../../src/luxon";

// Reference implementation: this is exactly what parseZoneInfo did before the
// caching change — construct a fresh Intl.DateTimeFormat on every call. The tests
// below assert that the cached code path produces character-identical output to
// this reference for every sampled instant, locale, and format.
function uncachedZoneName(ts, format, locale, timeZone = null) {
  const intlOpts = {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (timeZone) {
    intlOpts.timeZone = timeZone;
  }
  const modified = { timeZoneName: format, ...intlOpts };
  const parsed = new Intl.DateTimeFormat(locale, modified)
    .formatToParts(new Date(ts))
    .find((m) => m.type.toLowerCase() === "timezonename");
  return parsed ? parsed.value : null;
}

// 2026 DST transitions for America/New_York, in epoch milliseconds
const NY_SPRING_FORWARD = Date.UTC(2026, 2, 8, 7, 0, 0); // EST -> EDT
const NY_FALL_BACK = Date.UTC(2026, 10, 1, 6, 0, 0); // EDT -> EST (Nov 1)
// 2026 DST transitions for Australia/Sydney, in epoch milliseconds
const SYD_DST_END = Date.UTC(2026, 3, 4, 16, 0, 0); // AEDT -> AEST (Apr 5 local)
const SYD_DST_START = Date.UTC(2026, 9, 3, 16, 0, 0); // AEST -> AEDT (Oct 4 local)

const HOUR = 60 * 60 * 1000;

// every 15 minutes from 24h before to 24h after the transition, plus
// millisecond-level probes straddling the exact transition instant
function instantsAround(transition) {
  const instants = [];
  for (let offset = -24 * HOUR; offset <= 24 * HOUR; offset += 15 * 60 * 1000) {
    instants.push(transition + offset);
  }
  instants.push(transition - 1, transition, transition + 1);
  return instants;
}

function zoneNameFormats(dt) {
  return [dt.toFormat("ZZZZ"), dt.toFormat("ZZZZZ"), dt.offsetNameShort, dt.offsetNameLong];
}

function referenceFormats(ts, locale, zoneName) {
  return [
    uncachedZoneName(ts, "short", locale, zoneName),
    uncachedZoneName(ts, "long", locale, zoneName),
    uncachedZoneName(ts, "short", locale, zoneName),
    uncachedZoneName(ts, "long", locale, zoneName),
  ];
}

describe("zone name formatting matches the uncached reference", () => {
  test.each([
    ["America/New_York", NY_SPRING_FORWARD],
    ["America/New_York", NY_FALL_BACK],
    ["Australia/Sydney", SYD_DST_END],
    ["Australia/Sydney", SYD_DST_START],
  ])("is identical across the DST transition at %s (%s)", (zoneName, transition) => {
    const instants = instantsAround(transition);

    // run the sweep twice: the first pass populates the cache, the second one
    // is served entirely from it; both must match the uncached reference
    for (let pass = 0; pass < 2; pass++) {
      for (const ts of instants) {
        const dt = DateTime.fromMillis(ts, { zone: zoneName, locale: "en-US" });
        expect(zoneNameFormats(dt)).toEqual(referenceFormats(ts, "en-US", zoneName));
      }
    }
  });

  test.each(["en-US", "fr-FR", "de-DE", "ja-JP"])("is identical for locale %s", (locale) => {
    for (const ts of instantsAround(NY_FALL_BACK)) {
      const dt = DateTime.fromMillis(ts, { zone: "America/New_York", locale });
      expect(zoneNameFormats(dt)).toEqual(referenceFormats(ts, locale, "America/New_York"));
    }
  });

  test("is identical for zones without DST", () => {
    // one sample per month across a year, plus a couple of historical dates
    const instants = [];
    for (let month = 0; month < 12; month++) {
      instants.push(Date.UTC(2026, month, 15, 12, 0, 0));
    }
    instants.push(Date.UTC(1995, 5, 15), Date.UTC(2036, 0, 15));

    for (const ts of instants) {
      const dt = DateTime.fromMillis(ts, { zone: "Asia/Tokyo", locale: "en-US" });
      expect(zoneNameFormats(dt)).toEqual(referenceFormats(ts, "en-US", "Asia/Tokyo"));
    }
  });

  test("matches the reference for the system zone", () => {
    for (const ts of instantsAround(NY_SPRING_FORWARD)) {
      for (const format of ["short", "long"]) {
        expect(SystemZone.instance.offsetName(ts, { format, locale: "en-US" })).toBe(
          uncachedZoneName(ts, format, "en-US")
        );
      }
    }
  });

  test("hardcoded spot checks on either side of the New York transitions", () => {
    const justBeforeSpring = DateTime.fromMillis(NY_SPRING_FORWARD - 1, {
      zone: "America/New_York",
      locale: "en-US",
    });
    expect(justBeforeSpring.toFormat("ZZZZ")).toBe("EST");
    expect(justBeforeSpring.toFormat("ZZZZZ")).toBe("Eastern Standard Time");

    const justAfterSpring = DateTime.fromMillis(NY_SPRING_FORWARD, {
      zone: "America/New_York",
      locale: "en-US",
    });
    expect(justAfterSpring.toFormat("ZZZZ")).toBe("EDT");
    expect(justAfterSpring.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");

    const justBeforeFall = DateTime.fromMillis(NY_FALL_BACK - 1, {
      zone: "America/New_York",
      locale: "en-US",
    });
    expect(justBeforeFall.toFormat("ZZZZ")).toBe("EDT");

    const justAfterFall = DateTime.fromMillis(NY_FALL_BACK, {
      zone: "America/New_York",
      locale: "en-US",
    });
    expect(justAfterFall.toFormat("ZZZZ")).toBe("EST");
  });
});

describe("zone name formatter cache", () => {
  let NativeDTF, constructions;

  beforeEach(() => {
    constructions = 0;
    NativeDTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = class extends NativeDTF {
      constructor(...args) {
        constructions++;
        super(...args);
      }
    };
    Settings.resetCaches();
  });

  afterEach(() => {
    Intl.DateTimeFormat = NativeDTF;
    Settings.resetCaches();
  });

  test("constructs one Intl.DateTimeFormat and then reuses it", () => {
    const dt = DateTime.fromISO("2026-07-15T12:00:00", { zone: "America/New_York" });

    const cold = constructions;
    dt.offsetNameShort;
    expect(constructions - cold).toBe(1);

    for (let i = 0; i < 100; i++) {
      dt.offsetNameShort;
      dt.offsetNameLong;
      dt.toFormat("yyyy-MM-dd ZZZZ ZZZZZ");
    }
    // only the first offsetNameLong / ZZZZZ call adds an instance (new format);
    // everything else is served from the cache
    expect(constructions - cold).toBe(2);
  });

  test("keys the cache by zone, format, and locale", () => {
    const dt = DateTime.fromISO("2026-07-15T12:00:00", { zone: "America/New_York" });
    // build these up front: constructing a DateTime with a new zone creates its
    // own Intl.DateTimeFormat instances, which are not what we're measuring here
    const parisDt = DateTime.fromISO("2026-07-15T12:00:00", { zone: "Europe/Paris" });
    const frenchDt = dt.setLocale("fr-FR");
    dt.offsetNameShort;

    let snapshot = constructions;
    dt.offsetNameLong; // new format
    expect(constructions - snapshot).toBe(1);

    snapshot = constructions;
    parisDt.offsetNameShort; // new zone
    expect(constructions - snapshot).toBe(1);

    snapshot = constructions;
    frenchDt.offsetNameShort; // new locale
    expect(constructions - snapshot).toBe(1);

    snapshot = constructions;
    dt.offsetNameShort; // same as the very first call
    expect(constructions - snapshot).toBe(0);
  });

  test("is cleared by Settings.resetCaches() and keeps returning correct values", () => {
    const zone = "America/New_York";
    const instants = [...instantsAround(NY_SPRING_FORWARD), ...instantsAround(NY_FALL_BACK)];
    const formatAll = () =>
      instants.map((ts) => {
        const dt = DateTime.fromMillis(ts, { zone, locale: "en-US" });
        return [dt.toFormat("ZZZZ"), dt.toFormat("ZZZZZ")];
      });

    const beforeReset = formatAll();

    const snapshot = constructions;
    Settings.resetCaches();
    const afterReset = formatAll();

    // the cache was really cleared: formatters had to be constructed again
    expect(constructions - snapshot).toBeGreaterThan(0);
    // ...but the output is unchanged
    expect(afterReset).toEqual(beforeReset);
  });

  test("does not cache failures for invalid zone names", () => {
    const zone = IANAZone.create("Fantasia/Castle");
    const ts = Date.UTC(2026, 0, 15);

    let snapshot = constructions;
    expect(() => zone.offsetName(ts, { format: "short", locale: "en-US" })).toThrow();
    expect(constructions - snapshot).toBe(1);

    // a failed lookup must not be cached: it throws (and constructs) again
    snapshot = constructions;
    expect(() => zone.offsetName(ts, { format: "short", locale: "en-US" })).toThrow();
    expect(constructions - snapshot).toBe(1);
  });
});
