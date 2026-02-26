import { describe, it, expect, beforeEach } from "vitest";
import { saveSuggestions, loadSuggestions, clearSuggestions } from "./suggestions-store";
import type { Suggestion } from "./api";

describe("suggestions-store", () => {
  beforeEach(() => {
    // Clear all cookies before each test
    document.cookie.split(";").forEach((c) => {
      const name = c.trim().split("=")[0];
      if (name) document.cookie = `${name}=; path=/; max-age=0`;
    });
  });

  const mockSuggestions: Suggestion[] = [
    { title: "Fix bug", description: "Fix the login bug", prompt: "fix the login bug" },
    { title: "Add tests", description: "Add unit tests", prompt: "add unit tests" },
  ];

  it("saves and loads suggestions for a session", () => {
    saveSuggestions("session-abc-12345", mockSuggestions);
    const loaded = loadSuggestions("session-abc-12345");
    expect(loaded).toEqual(mockSuggestions);
  });

  it("returns empty array for unknown session", () => {
    expect(loadSuggestions("unknown-session")).toEqual([]);
  });

  it("clears suggestions for a session", () => {
    saveSuggestions("session-abc-12345", mockSuggestions);
    clearSuggestions("session-abc-12345");
    expect(loadSuggestions("session-abc-12345")).toEqual([]);
  });

  it("does not save empty suggestions array", () => {
    saveSuggestions("session-abc-12345", []);
    expect(loadSuggestions("session-abc-12345")).toEqual([]);
  });

  it("uses first 8 chars of session ID as cookie key", () => {
    saveSuggestions("abcdefgh-rest-of-id", mockSuggestions);
    // Should be retrievable with same session ID
    const loaded = loadSuggestions("abcdefgh-rest-of-id");
    expect(loaded).toEqual(mockSuggestions);
  });

  it("handles different session IDs independently", () => {
    const suggestions2: Suggestion[] = [
      { title: "Deploy", description: "Deploy app", prompt: "deploy" },
    ];
    // Use IDs that differ in first 8 chars (cookie key uses first 8)
    saveSuggestions("aaaaaaaa-rest-of-id", mockSuggestions);
    saveSuggestions("bbbbbbbb-rest-of-id", suggestions2);

    expect(loadSuggestions("aaaaaaaa-rest-of-id")).toEqual(mockSuggestions);
    expect(loadSuggestions("bbbbbbbb-rest-of-id")).toEqual(suggestions2);
  });
});
