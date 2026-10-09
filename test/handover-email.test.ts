import { describe, expect, test } from "vitest";
import { handoverMessage } from "@/lib/auth/mailer";

/**
 * The email somebody gets when a job is handed to them: the same card as the
 * sign-in code emails, with the job, the note quoted, and a button to the job.
 */
describe("handover email", () => {
  const notice = {
    to: "imran@vinylwraptoronto.com",
    fromName: "Paolo",
    businessName: "Vinyl Wrap Toronto",
    jobRef: "VIN-0001",
    jobTitle: "TEST: Full wrap – 2022 Ford Transit",
    note: "Client wants matte black.\nPanels are in the Drive folder.",
    jobUrl: "https://app.10xid.com/jobs/01a12145-ae26-708b-8a9a-7aa4a06e3573",
  };

  test("subject and text name who, which job, and where to open it", () => {
    const { subject, text } = handoverMessage(notice);
    expect(subject).toBe("Paolo handed you VIN-0001: TEST: Full wrap – 2022 Ford Transit");
    expect(text).toContain("Paolo handed you a job at Vinyl Wrap Toronto on 10XiD.");
    expect(text).toContain("  Client wants matte black.\n  Panels are in the Drive folder.");
    expect(text).toContain(`Open the job: ${notice.jobUrl}`);
  });

  test("the HTML has the job, the note line by line, and a button to the job", () => {
    const { html } = handoverMessage(notice);
    expect(html).toContain(">VIN-0001<");
    expect(html).toContain(">TEST: Full wrap – 2022 Ford Transit<");
    expect(html).toContain("Client wants matte black.<br>Panels are in the Drive folder.");
    expect(html).toContain(`href="${notice.jobUrl}"`);
    expect(html).toContain(">Open the job</a>");
  });

  test("without a note there is no note block", () => {
    const { html, text } = handoverMessage({ ...notice, note: null });
    expect(html).not.toContain("’s note");
    expect(text).not.toContain("Their note:");
  });

  test("what a teammate typed is text, never markup", () => {
    const { html } = handoverMessage({
      ...notice,
      fromName: "<b>Mallory</b>",
      jobTitle: 'Wrap "<img src=x onerror=alert(1)>"',
      note: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Mallory");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
