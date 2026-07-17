import { describe, it, expect } from "vitest";
import {
  FEEDBACK_SCRIPT_URL,
  feedbackScriptTag,
  matchesRoutePrefix,
} from "../src/feedback/core.js";

describe("FEEDBACK_SCRIPT_URL", () => {
  it("points at the feedback.profullstack.com embed", () => {
    expect(FEEDBACK_SCRIPT_URL).toBe(
      "https://feedback.profullstack.com/embed/profullstack-feedback.js"
    );
  });
});

describe("feedbackScriptTag", () => {
  it("is byte-identical to the snippet pasted into app layouts", () => {
    // ugig.net/src/app/layout.tsx, saasrow-web/app/layout.tsx, etc.
    expect(feedbackScriptTag({ property: "ugig.net" })).toBe(
      '<script async src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="ugig.net"></script>'
    );
  });

  it("embeds the given property key", () => {
    const tag = feedbackScriptTag({ property: "brisk.news" });
    expect(tag).toContain('data-property="brisk.news"');
    expect(tag).toContain(`src="${FEEDBACK_SCRIPT_URL}"`);
  });

  it("supports a custom script URL", () => {
    const tag = feedbackScriptTag({
      property: "example.com",
      src: "https://staging.example.com/embed.js",
    });
    expect(tag).toBe(
      '<script async src="https://staging.example.com/embed.js" data-property="example.com"></script>'
    );
  });

  it("emits a nonce attribute when provided (CSP strict-nonce apps)", () => {
    const tag = feedbackScriptTag({ property: "pairux.com", nonce: "abc123" });
    expect(tag).toBe(
      '<script async nonce="abc123" src="https://feedback.profullstack.com/embed/profullstack-feedback.js" data-property="pairux.com"></script>'
    );
  });

  it("escapes HTML attribute values", () => {
    const tag = feedbackScriptTag({
      property: 'bad"><img src=x>',
      src: 'https://x.test/?a=1&b="2"',
    });
    expect(tag).toContain('data-property="bad&quot;&gt;&lt;img src=x&gt;"');
    expect(tag).toContain('src="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(tag).not.toContain("<img");
  });
});

describe("matchesRoutePrefix", () => {
  const chatRoutes = ["/chat", "/chats", "/u", "/anon"];

  it("matches exact routes", () => {
    expect(matchesRoutePrefix("/chat", chatRoutes)).toBe(true);
    expect(matchesRoutePrefix("/u", chatRoutes)).toBe(true);
  });

  it("matches nested routes", () => {
    expect(matchesRoutePrefix("/chat/abc-123", chatRoutes)).toBe(true);
    expect(matchesRoutePrefix("/u/alice/settings", chatRoutes)).toBe(true);
  });

  it("does not match unrelated routes", () => {
    expect(matchesRoutePrefix("/", chatRoutes)).toBe(false);
    expect(matchesRoutePrefix("/pricing", chatRoutes)).toBe(false);
    expect(matchesRoutePrefix("/settings", chatRoutes)).toBe(false);
  });

  it("does not match on partial segment names", () => {
    // "/chat" must not hide "/chatroom"
    expect(matchesRoutePrefix("/chatroom", chatRoutes)).toBe(false);
    expect(matchesRoutePrefix("/users", chatRoutes)).toBe(false);
  });

  it("never matches when the pathname is unknown", () => {
    expect(matchesRoutePrefix(null, chatRoutes)).toBe(false);
    expect(matchesRoutePrefix(undefined, chatRoutes)).toBe(false);
    expect(matchesRoutePrefix("", chatRoutes)).toBe(false);
  });

  it("never matches with an empty prefix list", () => {
    expect(matchesRoutePrefix("/chat", [])).toBe(false);
  });

  it("ignores trailing slashes on prefixes", () => {
    expect(matchesRoutePrefix("/chat", ["/chat/"])).toBe(true);
    expect(matchesRoutePrefix("/chat/123", ["/chat/"])).toBe(true);
  });

  it("treats the root prefix as an exact match only", () => {
    expect(matchesRoutePrefix("/", ["/"])).toBe(true);
    expect(matchesRoutePrefix("/anything", ["/"])).toBe(false);
  });

  it("ignores empty prefixes", () => {
    expect(matchesRoutePrefix("/chat", [""])).toBe(false);
  });
});
