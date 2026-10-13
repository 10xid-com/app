import type { Submission } from "@/lib/db";

/**
 * The people who send work in, worked out from what they typed.
 *
 * There is no customers table: a website form sends whatever fields it has,
 * named however its author named them (`email`, `Email`, `e-mail`,
 * `your_email`). So each submission is read for an address, a phone number and
 * a name, and the submissions are grouped by the strongest of the three that
 * is there: the address, else the phone number, else the name. A submission
 * with none of them is counted, not guessed at.
 */

export type Customer = {
  /** What the submissions were grouped by, normalised. Stable while they are. */
  key: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Newest first. */
  submissions: Submission[];
  first: Date;
  last: Date;
};

const EMAIL = /^\S+@\S+\.\S+$/;

function field(details: Record<string, string>, test: RegExp, valid?: (v: string) => boolean): string | null {
  for (const [key, value] of Object.entries(details)) {
    const v = value.trim();
    if (v && test.test(key) && (!valid || valid(v))) return v;
  }
  return null;
}

/** The address, phone and name in one submission's details, where it has them. */
export function contactOf(details: Record<string, string> | null) {
  if (!details) return { email: null, phone: null, name: null };
  const email = field(details, /e-?mail/i, (v) => EMAIL.test(v));
  const phone = field(details, /phone|tel|mobile|cell/i, (v) => v.replace(/\D/g, "").length >= 7);
  const first = field(details, /^first[ _-]?name$/i);
  const last = field(details, /^(last|sur)[ _-]?name$/i);
  const name =
    field(details, /^((full|your|contact)[ _-]?)?name$/i) ?? ([first, last].filter(Boolean).join(" ") || null);
  return { email, phone, name };
}

export function customersFrom(rows: Submission[]): { customers: Customer[]; anonymous: number } {
  const byKey = new Map<string, Customer>();
  let anonymous = 0;

  for (const row of rows) {
    const c = contactOf(row.details);
    const key = c.email
      ? `email:${c.email.toLowerCase()}`
      : c.phone
        ? `phone:${c.phone.replace(/\D/g, "")}`
        : c.name
          ? `name:${c.name.toLowerCase().replace(/\s+/g, " ")}`
          : null;
    if (!key) {
      anonymous += 1;
      continue;
    }
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { key, ...c, submissions: [row], first: row.createdAt, last: row.createdAt });
      continue;
    }
    known.submissions.push(row);
    // Rows arrive newest first, so the first values seen are the latest; an
    // older submission only fills in what the newer ones left out.
    known.name ??= c.name;
    known.email ??= c.email;
    known.phone ??= c.phone;
    if (row.createdAt < known.first) known.first = row.createdAt;
    if (row.createdAt > known.last) known.last = row.createdAt;
  }

  const customers = [...byKey.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
  return { customers, anonymous };
}

/** Does this customer match what was typed into the search box? */
export function matches(customer: Customer, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [customer.name, customer.email, customer.phone, ...customer.submissions.map((s) => s.title)].some((v) =>
    v?.toLowerCase().includes(needle),
  );
}
