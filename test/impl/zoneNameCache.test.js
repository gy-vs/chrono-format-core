/* global test expect describe beforeEach afterEach */

import { DateTime, Settings, Zone } from "../../src/luxon";
import { parseZoneInfo } from "../../src/impl/util";

//
// These tests guard the caching of the Intl.DateTimeFormat instances used to
// render time-zone display names (the ZZZZ/ZZZZZ tokens, Zone#offsetName and
// custom-zone substitution). The formatters are cached per
// (locale, timeZone, timeZoneName) tuple; the instant is deliberately not part
// of the key, so a single formatter must render both sides of a DST boundary.
//

// Independent re-implementation of the pre-cache behavior: a brand-new
// Intl.DateTimeFormat on every call. Outputs must match it character for
// character, including around DST transitions.
function uncachedOffsetName(ts, offsetFormat, locale, timeZone = null) {
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
  const parsed = new Intl.DateTimeFormat(locale, { timeZoneName: offsetFormat, ...intlOpts })
    .formatToParts(new Date(ts))
    .find((m) => m.type.toLowerCase() === "timezonename");
  return parsed ? parsed.value : null;
}

// Timestamps sampled every 10 minutes across the 2024 spring-forward and
// fall-back transitions in New York and Europe, plus plain summer/winter
// anchors and a few distant years.
const dstEdgeTimestamps = [
  ...Array.from({ length: 18 }, (_, i) => Date.UTC(2024, 2, 10, 5, i * 10)), // NY spring forward ~07:00Z
  ...Array.from({ length: 30 }, (_, i) => Date.UTC(2024, 10, 3, 4, i * 10)), // NY fall back ~06:00Z
  ...Array.from({ length: 18 }, (_, i) => Date.UTC(2024, 2, 31, 0, i * 10)), // Europe spring forward ~01:00Z
  ...Array.from({ length: 18 }, (_, i) => Date.UTC(2024, 9, 27, 0, i * 10)), // Europe fall back ~01:00Z
  Date.UTC(2024, 0, 15, 12),
  Date.UTC(2024, 6, 15, 12),
  Date.UTC(1990, 0, 1, 0),
  Date.UTC(2037, 11, 31, 23),
];

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Lord_Howe", // 30-minute DST delta
  "Pacific/Chatham", // 45-minute offsets
  "Asia/Kathmandu", // fixed +05:45
  "Asia/Tehran",
  "Africa/Casablanca",
];

const LOCALES = ["en-US", "en-GB", "fr", "de", "ja", "zh-Hans-CN", "ru", "pt-BR", "ar-EG", ""];

describe("zone name formatter cache", () => {
  let realDTF;

  beforeEach(() => {
    Settings.resetCaches();
    realDTF = Intl.DateTimeFormat;
  });

  afterEach(() => {
    Intl.DateTimeFormat = realDTF;
    Settings.resetCaches();
  });

  function countingDTF() {
    const Original = realDTF;
    let count = 0;
    function Wrapped(...args) {
      count++;
      return new Original(...args);
    }
    Wrapped.prototype = Original.prototype;
    Object.defineProperty(Wrapped, "callCount", {
      get: () => count,
    });
    Intl.DateTimeFormat = Wrapped;
    return Wrapped;
  }

  test("steady-state formatting with a zone name constructs no Intl.DateTimeFormat", () => {
    const dt = DateTime.fromObject(
      { year: 2024, month: 6, day: 15, hour: 12 },
      { zone: "America/New_York" }
    );
    // warm the caches with the real constructor
    dt.toFormat("ZZZZ");
    dt.toFormat("ZZZZZ");

    const Counter = countingDTF();
    for (let i = 0; i < 1000; i++) {
      dt.toFormat("yyyy-MM-dd HH:mm:ss ZZZZ");
      dt.toFormat("yyyy-MM-dd HH:mm:ss ZZZZZ");
    }
    expect(Counter.callCount).toBe(0);
  });

  test("a (locale, zone, style) tuple constructs exactly one formatter, then reuses it", () => {
    const Counter = countingDTF();
    const dt = DateTime.fromObject(
      { year: 2024, month: 6, day: 15, hour: 12 },
      { zone: "America/New_York", locale: "en-US" }
    );

    // Operations such as setZone may resolve unrelated formatter instances
    // (e.g. to compute offsets), so count the delta each step adds.
    const newFormatsDuring = (f) => {
      const before = Counter.callCount;
      f();
      return Counter.callCount - before;
    };

    // first formatting with this (en-US, America/New_York, short) tuple
    expect(newFormatsDuring(() => dt.toFormat("ZZZZ"))).toBe(1);
    // subsequent ones reuse it
    expect(
      newFormatsDuring(() => {
        for (let i = 0; i < 100; i++) dt.toFormat("ZZZZ");
      })
    ).toBe(0);

    // a different style: first use builds it, later uses reuse it
    expect(newFormatsDuring(() => dt.toFormat("ZZZZZ"))).toBe(1);
    expect(
      newFormatsDuring(() => {
        for (let i = 0; i < 100; i++) dt.toFormat("ZZZZZ");
      })
    ).toBe(0);

    // a different zone is a different formatter (its first use builds at least it)
    const inLondon = dt.setZone("Europe/London");
    expect(newFormatsDuring(() => inLondon.toFormat("ZZZZ"))).toBeGreaterThanOrEqual(1);
    expect(
      newFormatsDuring(() => {
        for (let i = 0; i < 100; i++) inLondon.toFormat("ZZZZ");
      })
    ).toBe(0);

    // a different locale is a different formatter; note that switching to a
    // non-English locale may also build an unrelated resolved-options formatter
    const inLondonFr = inLondon.reconfigure({ locale: "fr" });
    expect(newFormatsDuring(() => inLondonFr.toFormat("ZZZZ"))).toBeGreaterThanOrEqual(1);
    expect(
      newFormatsDuring(() => {
        for (let i = 0; i < 100; i++) inLondonFr.toFormat("ZZZZ");
      })
    ).toBe(0);

    // revisiting the first tuple hits its original entry and builds nothing
    const backHome = inLondonFr.reconfigure({ locale: "en-US" }).setZone("America/New_York");
    expect(newFormatsDuring(() => backHome.toFormat("ZZZZ"))).toBe(0);
  });

  test("the cached formatter renders both sides of the DST boundary (instant is not part of the key)", () => {
    // America/New_York, 2024: spring forward at 2024-03-10 07:00Z,
    // fall back at 2024-11-03 06:00Z
    const beforeSpring = DateTime.fromMillis(Date.UTC(2024, 2, 10, 6, 59), {
      zone: "America/New_York",
    });
    const afterSpring = DateTime.fromMillis(Date.UTC(2024, 2, 10, 7, 0), {
      zone: "America/New_York",
    });
    const beforeFall = DateTime.fromMillis(Date.UTC(2024, 10, 3, 5, 59), {
      zone: "America/New_York",
    });
    const afterFall = DateTime.fromMillis(Date.UTC(2024, 10, 3, 6, 0), {
      zone: "America/New_York",
    });

    // warm a single (en-US, America/New_York, long) entry
    afterSpring.toFormat("ZZZZZ");

    const Counter = countingDTF();
    expect(beforeSpring.toFormat("ZZZZZ")).toBe("Eastern Standard Time");
    expect(afterSpring.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");
    expect(beforeFall.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");
    expect(afterFall.toFormat("ZZZZZ")).toBe("Eastern Standard Time");
    // and the short names
    expect(beforeSpring.toFormat("ZZZZ")).toBe("EST");
    expect(afterSpring.toFormat("ZZZZ")).toBe("EDT");
    expect(beforeFall.toFormat("ZZZZ")).toBe("EDT");
    expect(afterFall.toFormat("ZZZZ")).toBe("EST");
    // one reused formatter produced every one of those names
    expect(Counter.callCount).toBe(1);
  });

  test("output is character-for-character identical across zones, locales and DST edges", () => {
    for (const zone of ZONES) {
      for (const locale of LOCALES) {
        for (const style of ["short", "long"]) {
          for (const ts of dstEdgeTimestamps) {
            const expected = uncachedOffsetName(ts, style, locale || undefined, zone);
            const cached = parseZoneInfo(ts, style, locale || undefined, zone);
            expect(cached).toEqual(expected);

            // and through the public formatting API
            const token = style === "short" ? "ZZZZ" : "ZZZZZ";
            const dt = DateTime.fromMillis(ts, { zone, locale: locale || undefined });
            expect(dt.toFormat(token)).toEqual(expected);
          }
        }
      }
    }
  });

  test("different style names for the same instant never bleed into each other", () => {
    // interleaving short and long must not return the other style's name
    const summer = DateTime.fromObject(
      { year: 2024, month: 7, day: 1, hour: 12 },
      { zone: "America/New_York" }
    );
    const winter = DateTime.fromObject(
      { year: 2024, month: 1, day: 1, hour: 12 },
      { zone: "America/New_York" }
    );
    for (let i = 0; i < 25; i++) {
      expect(summer.toFormat("ZZZZ")).toBe("EDT");
      expect(summer.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");
      expect(winter.toFormat("ZZZZ")).toBe("EST");
      expect(winter.toFormat("ZZZZZ")).toBe("Eastern Standard Time");
    }
  });
});

describe("zone name cache reset", () => {
  let realDTF;

  beforeEach(() => {
    Settings.resetCaches();
    realDTF = Intl.DateTimeFormat;
  });

  afterEach(() => {
    Intl.DateTimeFormat = realDTF;
    Settings.resetCaches();
  });

  test("Settings.resetCaches drops the cached formatters and behavior stays correct", () => {
    const Original = realDTF;
    let count = 0;
    Intl.DateTimeFormat = function (...args) {
      count++;
      return new Original(...args);
    };
    Intl.DateTimeFormat.prototype = Original.prototype;

    const dt = DateTime.fromObject(
      { year: 2024, month: 6, day: 15, hour: 12 },
      { zone: "America/New_York" }
    );
    expect(dt.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");
    const builtOnce = count;
    expect(builtOnce).toBeGreaterThan(0);
    dt.toFormat("ZZZZZ");
    expect(count).toBe(builtOnce);

    Settings.resetCaches();

    // rebuilding from scratch must give the same answer and repopulate the cache
    expect(dt.toFormat("ZZZZZ")).toBe("Eastern Daylight Time");
    expect(count).toBe(builtOnce + 1);
    dt.toFormat("ZZZZZ");
    expect(count).toBe(builtOnce + 1);
  });

  test("outputs remain correct across DST edges after a cache reset", () => {
    const ts = Date.UTC(2024, 10, 3, 6, 0); // NY just after fall back
    const dt = DateTime.fromMillis(ts, { zone: "America/New_York" });
    expect(dt.toFormat("ZZZZ")).toBe("EST");
    Settings.resetCaches();
    expect(dt.toFormat("ZZZZ")).toBe("EST");
    expect(dt.toFormat("ZZZZZ")).toBe("Eastern Standard Time");
    Settings.resetCaches();
    expect(dt.toFormat("ZZZZZ")).toBe("Eastern Standard Time");
  });

  test("zone name cache does not leak between the reset and a different zone/locale", () => {
    const ny = DateTime.fromObject(
      { year: 2024, month: 1, day: 15, hour: 12 },
      { zone: "America/New_York" }
    );
    const london = DateTime.fromObject(
      { year: 2024, month: 1, day: 15, hour: 12 },
      { zone: "Europe/London" }
    );
    expect(ny.toFormat("ZZZZ")).toBe("EST");
    expect(london.toFormat("ZZZZ")).toBe("GMT");
    Settings.resetCaches();
    // after reset, tuples must be rebuilt and must not return another zone's name
    expect(ny.toFormat("ZZZZ")).toBe("EST");
    expect(london.toFormat("ZZZZ")).toBe("GMT");
    // the localized names must agree with a fresh uncached formatter rather
    // than a hard-coded string, since CLDR short names vary by ICU version
    const winterTs = DateTime.fromObject(
      { year: 2024, month: 1, day: 15, hour: 12 },
      { zone: "America/New_York" }
    ).toMillis();
    expect(ny.reconfigure({ locale: "fr" }).toFormat("ZZZZ")).toBe(
      uncachedOffsetName(winterTs, "short", "fr", "America/New_York")
    );
    expect(ny.reconfigure({ locale: "fr" }).toFormat("ZZZZZ")).toBe(
      uncachedOffsetName(winterTs, "long", "fr", "America/New_York")
    );
  });
});

describe("zone name caching for the system zone", () => {
  test("SystemZone.offsetName output matches an uncached formatter", () => {
    const sys = Settings.defaultZone;
    for (const ts of dstEdgeTimestamps) {
      for (const style of ["short", "long"]) {
        for (const locale of ["en-US", "de", "ja"]) {
          expect(sys.offsetName(ts, { format: style, locale })).toEqual(
            uncachedOffsetName(ts, style, locale)
          );
        }
      }
    }
  });
});

describe("zone name caching with custom zones", () => {
  // Custom zones are rendered through PolyDateFormatter's originalZone
  // substitution, which also relies on parseZoneInfo.
  class TickingZone extends Zone {
    constructor(offset) {
      super();
      this.offsetMinutes = offset;
    }
    get type() {
      return "custom";
    }
    get name() {
      return "Example/Custom";
    }
    get isUniversal() {
      return false;
    }
    get isValid() {
      return true;
    }
    offset() {
      return this.offsetMinutes;
    }
    formatOffset() {
      return "+05:30";
    }
    equals(other) {
      return other === this;
    }
    offsetName(ts, { format, locale }) {
      return uncachedOffsetName(ts, format, locale, "Asia/Kolkata");
    }
  }

  test("macro formats with zone names are unchanged and cached for custom zones", () => {
    const dt = DateTime.fromObject(
      { year: 2024, month: 6, day: 15, hour: 12 },
      { zone: new TickingZone(330) }
    );
    const expectedShort = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      timeZoneName: "short",
    })
      .formatToParts(dt.toJSDate())
      .find((p) => p.type === "timeZoneName").value;

    for (let i = 0; i < 10; i++) {
      expect(dt.toFormat("fff")).toContain(expectedShort);
    }
  });
});
