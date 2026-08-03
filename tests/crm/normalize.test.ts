// Ported from PersonalCRM2 lib/normalize.test.ts (node:test → vitest).
import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  emailDomain,
  normalizePhone,
  formatPhoneDisplay,
  normalizeLinkedin,
  normalizeDate,
  normalizeTags,
  normalizeName,
  isGenericEmailDomain,
} from "../../main/crm/normalize.ts";

describe("normalize", () => {
  it("email: lowercase, trim, strip +tag in norm", () => {
    expect(normalizeEmail("  Aamir+VC@X.com ")).toEqual({ raw: "Aamir+VC@X.com", norm: "aamir@x.com" });
    expect(normalizeEmail("kp@zero-rfi.ai")?.norm).toBe("kp@zero-rfi.ai");
    expect(normalizeEmail("cory@corylevy.com")?.norm).toBe("cory@corylevy.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(emailDomain("aidan.biggins@redwoodmaterials.com")).toBe("redwoodmaterials.com");
  });

  it("phone: US → +1, international kept, malformed → null", () => {
    expect(normalizePhone("(469) 343-3111")?.norm).toBe("+14693433111");
    expect(normalizePhone("469-343-3111")?.norm).toBe("+14693433111");
    expect(normalizePhone("1 (469) 343-3111")?.norm).toBe("+14693433111");
    // Imad Mokadem — international
    expect(normalizePhone("+41 78 257 1114")?.norm).toBe("+41782571114");
    // Emmy Scott case: no usable number → null (leave blank, flag incomplete)
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeNull(); // too short
    expect(normalizePhone("555-CALL")).toBeNull();
  });

  it("phone display: E.164 → (XXX) XXX-XXXX for US", () => {
    expect(formatPhoneDisplay("+14693433111")).toBe("(469) 343-3111");
    expect(formatPhoneDisplay("+41782571114")).toBe("+41782571114");
    expect(formatPhoneDisplay("")).toBe("");
  });

  it("linkedin: canonical linkedin.com/in/<slug>", () => {
    expect(normalizeLinkedin("https://www.linkedin.com/in/JBStraubel/")?.norm).toBe("linkedin.com/in/jbstraubel");
    expect(normalizeLinkedin("http://linkedin.com/in/cory-levy?trk=foo")?.norm).toBe("linkedin.com/in/cory-levy");
    expect(normalizeLinkedin("linkedin.com/in/kp-reddy/")?.norm).toBe("linkedin.com/in/kp-reddy");
    expect(normalizeLinkedin("in/grace-kasten")?.norm).toBe("linkedin.com/in/grace-kasten");
    expect(normalizeLinkedin("")).toBeNull();
  });

  it("date: mixed inputs → ISO, ambiguous → null", () => {
    expect(normalizeDate("2026-05-31")).toBe("2026-05-31");
    expect(normalizeDate("05/08/2026")).toBe("2026-05-08");
    expect(normalizeDate("May 8, 2026")).toBe("2026-05-08");
    expect(normalizeDate("Jun 1 2026")).toBe("2026-06-01");
    expect(normalizeDate("18 Apr 2024")).toBe("2024-04-18"); // LinkedIn export format
    expect(normalizeDate("September")).toBeNull(); // no year → leave NULL
    expect(normalizeDate("2026-13-40")).toBeNull(); // impossible date
    expect(normalizeDate("")).toBeNull();
  });

  it("tags: lowercase, hyphenate, dedupe, comma-separate", () => {
    expect(normalizeTags("Construction Tech, Investor, construction-tech,  Georgia Tech ")).toBe(
      "construction-tech, investor, georgia-tech"
    );
    expect(normalizeTags("environment, materials, regenerative, st-marks, forbes-30u30")).toBe(
      "environment, materials, regenerative, st-marks, forbes-30u30"
    );
    expect(normalizeTags("")).toBe("");
  });

  it("name key: lowercase, punctuation-light, single-spaced", () => {
    expect(normalizeName("Jerry Jones Jr.")).toBe("jerry jones jr");
    expect(normalizeName("  Rolland   P  Johnson ")).toBe("rolland p johnson");
  });

  it("generic email domains: webmail providers flagged, company domains not", () => {
    // Generic providers — must NOT corroborate a name match (everyone shares them)
    expect(isGenericEmailDomain("gmail.com")).toBe(true);
    expect(isGenericEmailDomain("GMail.com")).toBe(true); // case-insensitive
    expect(isGenericEmailDomain("icloud.com")).toBe(true);
    expect(isGenericEmailDomain("outlook.com")).toBe(true);
    expect(isGenericEmailDomain("proton.me")).toBe(true);
    // Company domains — DO corroborate
    expect(isGenericEmailDomain("zero-rfi.ai")).toBe(false);
    expect(isGenericEmailDomain("redwoodmaterials.com")).toBe(false);
    expect(isGenericEmailDomain("")).toBe(false);
  });
});
