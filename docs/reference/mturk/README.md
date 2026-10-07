# Amazon Mechanical Turk API docs — local archive

**Amazon Mechanical Turk shuts down permanently on 30 September 2026.** These pages
go offline with it. This directory is a snapshot of the parts of the MTurk API
Reference and Requester Developer Guide that describe a pool-and-claim work
marketplace: jobs enter a pool, qualified workers claim them, a reviewer approves
or rejects, workers get paid per piece.

Retrieved **2026-09-20**, ten days before closure. 36 files, ~160 KB.

This is **not our content**. It is Amazon's documentation, kept verbatim as reference
material while we design Flow's work-pool model. Nothing here is a decision we have
made. Do not copy prose out of it into anything we publish.

## Why we kept it

MTurk is the only large marketplace of this exact shape that also documented its
schema properly. The field tables are the point: what a claim record actually
contains, what states it moves through, which clocks run, and what the gating
predicate looks like. We are keeping the **vocabulary and the schema**, not the
product.

## How it was captured

AWS's documentation site serves the raw generated Markdown at the same path as the
rendered page — swap `.html` for `.md`:

```
https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_HITDataStructureArticle.md
```

That is what these files are: the upstream Markdown, byte-for-byte, with a
three-line provenance header prepended. No HTML scraping, so the tables are the
original tables and not a conversion of them. (There is no public `awsdocs` GitHub
repository for MTurk — searched, none exists. The `.md` endpoint is the shortcut.)

Because filenames match the upstream Markdown names, the relative links *between*
captured pages still work. Links to pages we did not capture will 404 — see
"Could not capture" below.

---

## Vocabulary map: MTurk → Flow

The part that earns this directory's keep. Read the right-hand column as "what we
call it", and read the notes hard — the analogy breaks in places that matter.

| MTurk | Flow | Holds / breaks |
| --- | --- | --- |
| **HIT** (Human Intelligence Task) | **job** (a *touch* when it is one unit of work on one item) | Holds well. Note MTurk's HIT is a *template plus a quantity*: one HIT with `MaxAssignments: 5` is one job that five different contractors each do once, independently. Our jobs are mostly `MaxAssignments: 1`. If we never need N-independent-copies, we can collapse HIT and Assignment into one record — MTurk could not. |
| **HITType** | (no equivalent yet) | A HITType is the deduplicated bundle of title, description, keywords, reward, assignment duration, auto-approval delay and qualification requirements. HITs sharing a HITType are grouped in the marketplace so a contractor can do one after another without re-qualifying. This is a **job template**, and it is a good idea we do not have. |
| **Assignment** | **claim** | Holds very well — including the fact that the claim record is created at claim time, carries `AcceptTime` and `Deadline`, and later carries the submitted work. |
| **Qualification** (a granted value for a worker) | **qualification** | Holds. Note MTurk's is a *typed value*, not a boolean: a qualification has an integer or locale value, and the gate is a comparison against it. Ours are currently boolean. Going typed costs little and buys a lot. |
| **QualificationType** | qualification definition | Holds. |
| **QualificationRequirement** | the gate on a job | Holds. See `ActionsGuarded` below — this is the field we are missing. |
| **Requester** | **client** | Holds. |
| **Worker** | **contractor** | Holds. |
| **Reward** | piece rate | Holds. MTurk's is a flat per-assignment amount in USD. |
| **`AutoApprovalDelayInSeconds`** | the auto-approve clock **we do not have yet** | The single most useful thing in here. See below. |
| **`AssignmentDurationInSeconds`** | claim expiry / hold time | We have no hold timer at all. |
| **`LifetimeInSeconds`** / **`Expiration`** | how long a job stays in the pool | We have no pool expiry. |
| **`HITStatus`** | job status | `Assignable / Unassignable / Reviewable / Reviewing / Disposed`. Maps loosely to open / fully-claimed / awaiting-review / disposed. |
| **`AssignmentStatus`** | claim status | Only `Submitted / Approved / Rejected` — see the trap below. |
| **`NumberofAssignmentsPending / Available / Completed`** | pool counters | Derived counters on the job. We currently recompute these; MTurk stores them. |
| **Block** (`CreateWorkerBlock`) | client-level contractor block | Holds. Amazon explicitly advises using a *qualification* rather than a block for "not skilled enough", and reserving blocks for bad faith. Good guidance. |
| **Bonus** (`SendBonus`) | ad-hoc extra payment | Holds. Requires a prior approved assignment to attach to. |
| **Review Policy** | (deliberately not captured) | MTurk's automated server-side QA (gold-standard answers, plurality agreement). Out of scope for now; the pages exist upstream if we want them. |

### Where the analogy breaks

- **MTurk has no "in progress" assignment state, and no returned/abandoned state.**
  `AssignmentStatus` is only `Submitted | Approved | Rejected`. A claim that is
  accepted but not yet submitted has *no* Assignment record you can list, and a claim
  that is returned or that times out **leaves no record at all** — the assignment
  simply decrements `NumberofAssignmentsPending` and increments
  `NumberofAssignmentsAvailable` again (`RetrievingHitStatus.md`). This is a
  deliberate MTurk design choice and we should probably **not** copy it: it means a
  requester cannot see who abandoned work, or how often. We want abandonment to be a
  first-class, recorded event, because reputation depends on it.
- **MTurk is anonymous and single-round.** There is no negotiation, no back-and-forth,
  no revision request. Reject is terminal (reversible within 30 days, but it is a
  reversal, not a revision loop). If Flow wants "send it back for a fix", there is no
  MTurk precedent to copy — design it fresh.
- **One approver, no hierarchy.** The Requester who created the job is the only party
  who can approve. Nothing here models a separate approver role, delegation, or
  multi-stage sign-off.
- **Payment is Amazon-custodial.** Reward moves from a prefunded Requester balance.
  Nothing here is useful for our payout rails.
- **Qualification values are global to a requester, not per-job.** A worker's
  qualification value is a property of the worker, set by one client, and reused
  across all that client's jobs. System qualifications (approval rate, locale) are
  global across the whole marketplace.

### The clocks — the bit we are missing

Three separate timers, and they are genuinely independent. From
`mturk-hits-attributes.md` and `ApiReference_HITDataStructureArticle.md`:

- **`LifetimeInSeconds`** — how long the job stays visible and claimable in the pool.
  When it elapses the job leaves the marketplace **even if unclaimed assignments
  remain**. Materialised as `Expiration`, an absolute timestamp.
- **`AssignmentDurationInSeconds`** — how long a contractor has to finish *after
  claiming*. Materialised per claim as `Deadline` (= `AcceptTime` + duration). If it
  elapses the claim evaporates and the work returns to the pool for someone else.
  Amazon's guidance: long enough to absorb trouble, short enough that work is not
  orphaned, and not so long that the rate looks insulting for the implied effort.
- **`AutoApprovalDelayInSeconds`** — how long the client has to approve or reject
  *after submission* before the system approves and pays automatically. Materialised
  per claim as `AutoApprovalTime` (= `SubmitTime` + delay). Set to `0` to auto-approve
  everything.

Crucially, **lifetime expiry does not kill a claim already in flight**: "if the
lifetime expires after a worker accepts an assignment, the worker can still submit a
response up until the assignment duration expires."

The auto-approve clock is the one to steal first. It converts "the client forgot"
from a contractor's problem into the client's problem, which is the correct place for
it, and it makes payment timing predictable without any human in the loop.

### The gating predicate

`ActionsGuarded` on a `QualificationRequirement` takes one of three values, and this
is a nicer design than a boolean can/cannot:

- `Accept` — contractor sees the job and can open it, but cannot claim it (default)
- `PreviewAndAccept` — contractor sees it listed, cannot open the contents
- `DiscoverPreviewAndAccept` — contractor never sees it at all

Least restrictive to most restrictive is Discover → Preview → Accept, and with several
requirements on one job a contractor must pass **all** requirements guarding an action
to perform it. Full table and worked examples in
`ApiReference_QualificationRequirementDataStructureArticle.md`, which is the single
most valuable file in here.

Comparators: `LessThan | LessThanOrEqualTo | GreaterThan | GreaterThanOrEqualTo |
EqualTo | NotEqualTo | Exists | DoesNotExist | In | NotIn`.

System-assigned qualification types worth knowing about (same file):
`Worker_NumberHITsApproved` (lifetime approved count), `Worker_PercentAssignmentsApproved`
(approval rate — and note the 100-assignment floor, below which everyone reads as
100%, to stop one rejection wrecking a newcomer), `Worker_Locale` (ISO 3166, with
subdivisions), `Worker_Adult`, and Masters.

---

## What is in here

### Index pages
- `Welcome.md` — API Reference front page
- `ApiReference_OperationsArticle.md` — full operation list (includes operations we did not capture)
- `ApiReference_DataStructuresArticle.md` — full data structure list

### Data structures
- `ApiReference_HITDataStructureArticle.md` — **the job record**; all three clocks, `HITStatus`, the assignment counters
- `ApiReference_AssignmentDataStructureArticle.md` — **the claim record**; `Deadline`, `AcceptTime`, `SubmitTime`, `AutoApprovalTime`, `AssignmentStatus`
- `ApiReference_QualificationRequirementDataStructureArticle.md` — **`ActionsGuarded`, comparators, system qualification type IDs**
- `ApiReference_QualificationTypeDataStructureArticle.md`
- `ApiReference_QualificationDataStructureArticle.md`
- `ApiReference_QualificationRequestDataStructureArticle.md`
- `ApiReference_LocaleDataStructureArticle.md`

### Job lifecycle operations
- `ApiReference_CreateHITOperation.md` — every clock as a request parameter
- `ApiReference_CreateHITTypeOperation.md` — the job-template idea
- `ApiReference_GetHITOperation.md`
- `ApiReference_UpdateExpirationForHITOperation.md` — extend or immediately expire a pooled job
- `ApiReference_CreateAdditionalAssignmentsForHITOperation.md` — widen an open job

### Claim and review operations
- `ApiReference_GetAssignmentOperation.md`
- `ApiReference_ListAssignmentsForHITOperation.md`
- `ApiReference_ListReviewableHITsOperation.md`
- `ApiReference_ApproveAssignmentOperation.md`
- `ApiReference_RejectAssignmentOperation.md`

### Qualification operations
- `ApiReference_CreateQualificationTypeOperation.md`
- `ApiReference_UpdateQualificationTypeOperation.md`
- `ApiReference_AssociateQualificationWithWorkerOperation.md` — grant
- `ApiReference_DisassociateQualificationFromWorkerOperation.md` — revoke
- `ApiReference_AcceptQualificationRequestOperation.md`
- `ApiReference_RejectQualificationRequestOperation.md`
- `ApiReference_GetQualificationScoreOperation.md`

### Reputation, bonuses, blocking
- `ApiReference_SendBonusOperation.md`
- `ApiReference_CreateWorkerBlockOperation.md`
- `ApiReference_ListWorkerBlocksOperation.md`

### Developer Guide narrative pages
The API Reference is a schema dump and does not explain behaviour. These six pages do,
and they answer questions the reference cannot:
- `mturk-hits-attributes.md` — **the clearest explanation of the three clocks anywhere in the docs**
- `RetrievingHitStatus.md` — `HITStatus` transitions and a worked lifecycle table showing the counters moving as assignments are accepted, returned and submitted
- `RetrievingResults.md` — how `AutoApprovalTime` is computed, assignment attributes in practice
- `SelectingEligibleWorkers.md` — the qualification gating narrative, with the full comparator table
- `ApproveRejectWork.md` — **rejection norms and worker recourse**, including the 30-day rule: a rejection can be reversed by calling `ApproveAssignment` with `OverrideRejection: true`, but only for assignments submitted within the previous 30 days and only if the related job has not been deleted
- `BlockingWorkers.md` — blocking, and Amazon's advice to prefer qualifications over blocks

---

## Could not capture

Nothing failed. Every page listed above returned real content — verified by reading
files back, not by trusting exit codes. All 31 Markdown tables were checked
programmatically for column-count consistency and all are intact.

Deliberately **not** captured, so their inbound relative links from these files will
404:

- **Question and answer formats** — `ApiReference_QuestionFormDataStructureArticle`,
  `ApiReference_ExternalQuestionArticle`, `ApiReference_QuestionFormAnswersDataStructureArticle`,
  `ApiReference_HTMLQuestionArticle`, `ApiReference_QuestionAnswerDataArticle`.
  MTurk's XML/HTML task-rendering format. Genuinely obsolete and not the shape of
  anything we are building.
- **Review Policies** — `ApiReference_ReviewPoliciesArticle`,
  `ApiReference_HITReviewPolicyDataStructureArticle`,
  `ApiReference_ListReviewPolicyResultsForHITOperation`. Automated server-side QA
  (gold standards, plurality agreement). Interesting but out of the scope we agreed;
  fetch them the same way if we ever want them.
- **Notifications** — `ApiReference_NotificationReceptorAPIArticle`,
  `UpdateNotificationSettings`, `SendTestEventNotification`, `NotifyWorkers`.
- **Remaining operations** — `CreateHITWithHITType`, `DeleteHIT`, `ListHITs`,
  `ListHITsForQualificationType`, `ListQualificationRequests`, `ListQualificationTypes`,
  `ListWorkersWithQualificationType`, `ListBonusPayments`, `GetAccountBalance`,
  `GetFileUploadURL`, `GetQualificationType`, `DeleteQualificationType`,
  `DeleteWorkerBlock`, `UpdateHITReviewStatus`, `UpdateHITTypeOfHIT`. Routine CRUD
  and paging variants; all listed in `ApiReference_OperationsArticle.md` and all
  fetchable by the `.md` trick until 30 September 2026.
- **`HITLayoutParameter`** and **SDK language bindings** — out of scope.
- **Worker-facing pages on mturk.com** — out of scope, and going away sooner.

One cosmetic wart, faithful to upstream: the "Adding Adult Content" section of
`ApiReference_QualificationRequirementDataStructureArticle.md` contains two raw HTML
`<table>` blocks instead of Markdown tables. That is how Amazon generates it. It
renders fine and the content is intact.

**If you need something from the list above, get it before 30 September 2026.**
After that, try the Internet Archive and expect gaps.
