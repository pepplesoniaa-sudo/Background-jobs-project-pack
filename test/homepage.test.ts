import { describe, expect, it } from "vitest";
import { HOME_PAGE_HTML, HOME_PAGE_JS } from "../src/homePage.js";

// DATABASE-FREE AND MAIL-FREE. Reads two strings. No existing test checked the home page's To field, so
// these are new tests, not edited ones.

const toField = /<input id="to"[^>]*>/.exec(HOME_PAGE_HTML)![0];

describe("S9 home page: the To field (G23)", () => {
  it("starts EMPTY: no value attribute at all, and no default address anywhere in the page or script", () => {
    expect(toField).not.toMatch(/\bvalue\s*=/);
    expect(HOME_PAGE_HTML).not.toContain("nobody@example.test");
    expect(HOME_PAGE_JS).not.toContain("nobody@example.test");
    expect(HOME_PAGE_JS).not.toMatch(/toEl\.value\s*=/); // the script never fills it in either
  });

  it("stays required, is an email field, and still goes out as payload.to", () => {
    expect(toField).toMatch(/\brequired\b/);
    expect(toField).toContain('type="email"');
    expect(HOME_PAGE_JS).toContain("to: toEl.value");
  });
});

describe("S9 home page: what 'succeeded' means", () => {
  it("shows the line: Succeeded means the mail server accepted the message. It does not confirm delivery.", () => {
    expect(HOME_PAGE_HTML).toContain("Succeeded means the mail server accepted the message. It does not confirm delivery.");
  });

  it("the page still asks for no secret and keeps its policy-friendly shape", () => {
    expect(HOME_PAGE_HTML).not.toMatch(/type="password"/i);
    expect(HOME_PAGE_JS).not.toContain("innerHTML");
    expect(HOME_PAGE_JS).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
