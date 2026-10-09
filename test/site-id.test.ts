import { describe, expect, test } from "vitest";
import { liveIdFor, parseIdPreviews } from "@/lib/sites/id";

describe("which business has a live iD", () => {
  test("a named business gets its preview and its own address", () => {
    expect(liveIdFor("vinyl-wrap-toronto", "vinyl-wrap-toronto:vwt")).toEqual({
      slug: "vwt",
      previewUrl: "https://preview.10xid.com/id/vwt/",
      address: "vwt.10xid.com",
      launchUrl: "https://vwt.10xid.com/",
    });
  });

  test("unset, or a business it does not name, has none", () => {
    expect(liveIdFor("vinyl-wrap-toronto", undefined)).toBeNull();
    expect(liveIdFor("vinyl-wrap-toronto", "")).toBeNull();
    expect(liveIdFor("rotary", "vinyl-wrap-toronto:vwt")).toBeNull();
  });

  test("several pairs, spaces and case are read", () => {
    const map = parseIdPreviews(" Vinyl-Wrap-Toronto : VWT , route-401:route401 ");
    expect([...map]).toEqual([
      ["vinyl-wrap-toronto", "vwt"],
      ["route-401", "route401"],
    ]);
  });

  test("an iD slug that could leave its hostname or path is dropped", () => {
    for (const bad of ["a:evil.com/x", "a:../x", "a:x.y", "a:-x", "a:x-", "a:", "a:a b", "a:x?y"]) {
      expect(liveIdFor("a", bad), bad).toBeNull();
    }
  });
});
