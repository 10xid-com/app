import { describe, expect, test } from "vitest";
import { contactOf, customersFrom, matches } from "@/lib/customers";
import type { Submission } from "@/lib/db";

let n = 0;
function sent(details: Record<string, string> | null, daysAgo = 0): Submission {
  n += 1;
  return {
    id: `id-${n}`,
    ref: `ROT-${String(n).padStart(4, "0")}`,
    title: `Request ${n}`,
    kind: "quote",
    status: "open",
    createdAt: new Date(Date.UTC(2026, 9, 13) - daysAgo * 86_400_000),
    details,
  };
}

describe("reading a submission for who sent it", () => {
  test("whatever the form called the fields", () => {
    expect(contactOf({ Email: "Jo@Example.com", "Phone Number": "416 555 0100", Name: "Jo" })).toEqual({
      email: "Jo@Example.com",
      phone: "416 555 0100",
      name: "Jo",
    });
    expect(contactOf({ your_email: "a@b.co", first_name: "Ada", last_name: "Lovelace" })).toMatchObject({
      email: "a@b.co",
      name: "Ada Lovelace",
    });
  });

  test("a field that is named right but holds no address or number is not one", () => {
    expect(contactOf({ email: "ask me", phone: "n/a" })).toEqual({ email: null, phone: null, name: null });
    expect(contactOf(null)).toEqual({ email: null, phone: null, name: null });
  });
});

describe("grouping submissions into customers", () => {
  test("one person per address, whatever its case; the newest details win", () => {
    const { customers, anonymous } = customersFrom([
      sent({ email: "jo@example.com", name: "Jo Bloggs" }, 1),
      sent({ email: "JO@example.com", name: "Jo", phone: "416-555-0100" }, 5),
      sent({ email: "sam@example.com" }, 3),
    ]);
    expect(anonymous).toBe(0);
    expect(customers.map((c) => [c.email, c.submissions.length])).toEqual([
      ["jo@example.com", 2],
      ["sam@example.com", 1],
    ]);
    // The name from the newer submission; the phone only the older one had.
    expect(customers[0]).toMatchObject({ name: "Jo Bloggs", phone: "416-555-0100" });
    expect(customers[0].first.getTime()).toBeLessThan(customers[0].last.getTime());
  });

  test("by phone when there is no address, by name when there is neither; nothing guessed", () => {
    const { customers, anonymous } = customersFrom([
      sent({ phone: "(416) 555-0100" }),
      sent({ tel: "416.555.0100" }),
      sent({ name: "Pat  Doe" }),
      sent({ name: "pat doe" }),
      sent({ message: "Call me" }),
      sent(null),
    ]);
    expect(customers.map((c) => c.submissions.length)).toEqual([2, 2]);
    expect(anonymous).toBe(2);
  });

  test("search reads the name, the contact details and what they asked for", () => {
    const { customers } = customersFrom([sent({ email: "jo@example.com", name: "Jo Bloggs" })]);
    expect(matches(customers[0], "bloggs")).toBe(true);
    expect(matches(customers[0], "EXAMPLE")).toBe(true);
    expect(matches(customers[0], customers[0].submissions[0].title)).toBe(true);
    expect(matches(customers[0], "nobody")).toBe(false);
  });
});
