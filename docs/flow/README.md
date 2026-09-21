# Flow — the thinking behind it

Paolo's design, recorded as it was decided, September 2026. This is the WHY.
The tables come later and must serve this; where a table and this document
disagree, one of them is wrong and it is worth finding out which.

## The business, in one paragraph

Work that is technical rather than creative — digitising a logo for a cap,
vectorising artwork, a print run — is bought from qualified people anywhere in
the world for four or five dollars and sold here for twenty. The buyer is not
being gouged: twenty is close to what it would have cost them locally, and the
alternative was guaranteeing somebody a full-time wage to do it occasionally.
The worker is not being exploited either — see the next section, which is a
constraint on the model and not a sentiment attached to it.

## The wage rule, which is a constraint

> "In no circumstance am I looking to see people be abused financially. I am
> hoping to see average people make something above average for where they
> live."

And the other half, which is the part that is easy to forget:

> "We don't want to be overpaying in markets just because we can afford it.
> Because all we're going to be doing is raising the commodity price."

So the target is a BAND, not a number: comfortably above local average, not so
far above that it distorts the local market for that skill.

Two consequences for the schema.

**A rate is per task type AND per market.** Venezuela and Bangladesh can be paid
differently for identical work, for reasons that are legitimate — cost of
living, who was awake, who was available, how close the deadline was.

**Store the rate as a multiple of a local reference, not as a bare number.**
"1.3x the local median for this skill" is a policy that can be reviewed and that
moves when local wages move. A hard-coded 4.50 drifts silently and nobody
notices for two years. It also means that when a contractor asks why another
market earns more — and they will, because people talk — there is a stated
policy to point at rather than a number somebody typed once.

**Record the REASON for a rate alongside the amount.** Availability, time zone,
deadline pressure, market reference. The difference between a defensible
policy and a grievance is whether it can be explained afterwards.

## Work is bought in touches

The unit is not the job. It is the TOUCH: one paid act by one person. For a
digitised cap logo there are three — quote, digitize, approve — each with its
own holder, its own fee, its own clock and its own state. One person may hold
several roles; they simply hold several rows.

Rates differ enormously by touch. Quoting or approving might pay 25 to 50
cents; digitising the same job pays seven dollars. That is correct: they take
materially different amounts of time and skill.

Outsourcing a whole touch to a supplier — a commercial printer, an embroidery
house — is the same row with a supplier instead of a person. Purchase orders
are therefore not a second system; they are the outsourced touches on a job,
grouped.

## Who may not do what

- The person who DOES the work must be a different person at a DIFFERENT
  COMPANY from the person who approves it.
- Estimator and approver may be the same person, at least to begin with.

That second rule is a concession to a small pool and can tighten later. The
first is load-bearing, and it closes an exploit for free: an approver paid to
reject cannot then claim the rework, because claiming it would make them the
doer of work they are set to approve. **The constraint must therefore apply
across the whole rework chain, not just one row** — the second attempt is a new
row with no memory of who rejected the first.

## Time

The smallest unit is one minute.

Every task type has a STANDARD TIME. The worker's window is that standard plus
a buffer, so somebody can answer the door or take a call from their family
without losing the job:

| standard time | buffer |
| --- | --- |
| under 20 minutes | 5 minutes |
| 20 to 40 minutes | 10 minutes |
| over 40 minutes | 15 minutes |

A three-minute quote is therefore allowed eight minutes. A one-hour digitise is
allowed an hour and fifteen. Past that, the claim is pulled and the work
returns to the pool. The worker loses it, and loses the fee, even at ninety per
cent complete.

That is deliberately harsh and the reason is stated plainly: what cannot happen
is somebody taking a fifteen-minute job, taking the weekend off, and leaving a
client waiting until Tuesday.

**The allowed time is pinned when the task is created.** Change the bands next
month and nothing in flight moves. Same discipline as price.

**The bands are data, not a CASE statement.** 5/10/15 is a first guess that
will be revised once real people have been watched working.

### Two clocks, not one

This is easy to conflate and must not be.

The worker's window is standard-plus-buffer, in minutes. The CLIENT'S promised
date is something else entirely, and Paolo's practice is to promise
generously — an hour's work promised for tomorrow, three weeks' work promised
in five. The slack between the two is deliberate commercial safety and belongs
to the business, not to the worker.

So: `std_minutes` and the worker's deadline are internal. `promised_at` is what
the client sees. They are different columns and the buffer bands apply only to
the first.

### Extensions

A worker may request an extension and must say how much time they need. If they
miss the extended deadline too, they lose the job and the fee.

**The reason code decides what happens to the money**, and there are two cases
that look identical at the button and are opposite underneath:

- **Our estimate was wrong.** The standard time was too low; the worker is not
  slow, the price book is. Their rate is adjusted to what it would have been
  had the job been quoted correctly. The same row is the signal to fix the
  standard time for that task type.
- **Something personal.** Their child needs them, they have an appointment.
  Discretionary — grant or refuse, and refusing is legitimate. Twenty minutes
  is a different ask from two hours, and a reliable person is a different ask
  from a wild card.

Refusing is expected to be normal. Most people, facing the loss of a nearly
finished job, will finish it rather than come back tomorrow. If they rush it
and botch it, approval catches it and they lose it anyway.

### Giving a job back

A worker who knows they cannot finish should be able to say so and hand it
straight back.

**This must be recorded differently from timing out, and must cost less.** If a
clean release and a silent abandonment look the same in the record, there is no
reason to release — you may as well sit on it and hope. The whole behaviour
Paolo wants here only appears if the system rewards it.

## Quality

Binary. Satisfactory or not, with notes. This is technical work: the file either
works or it does not.

**Everyone starts in training**, and during training two workers do the same job
independently. Two quotes that land close together are both probably right; two
that diverge mean something is wrong and a human should look. The measurement
comes from AGREEMENT rather than from an authority — which is what stops the
system depending on a 25-cent approver being conscientious.

Once somebody qualifies as a trainer, the trainer inspects instead, and the
doubling stops. So cost per job falls as the pool matures: two people at seven
dollars becomes one person at fifty cents. That curve is worth watching, because
it is the one that says whether the model works.

Qualification is a LEVEL per task type — training, qualified, trainer — not a
flag. Somebody may be a trainer at quoting and still in training at digitising.
Enough unsatisfactory marks and they lose that task type while keeping the
others.

Three refinements that are not optional:

**A quote needs a tolerance, not a boolean.** $47 and $52 are neither identical
nor wrong. For pricing work the comparison is a distance first; the verdict
follows from whether it fell inside a band.

**Two binary approvers cannot disagree usefully.** They agree, which says
little, or they deadlock, which resolves nothing. Redundant approval needs
three graders, or two plus a trainer to break ties.

**A newcomer's score must not be destroyed by one early rejection.** MTurk's
approval-rate qualification reads 100% until a worker has enough submissions to
be judged fairly. Copy that, or good people are lost in their first week.

## Creative work comes later

Binary grading is right for technical work and wrong for creative work, so
creative waits.

When it arrives the shape is already visible: AI produces the design and the
skill being bought is DIRECTING it — knowing what to ask for and whether what
came back is right. That is a task type like any other, and it grades on a
rubric rather than a boolean.

So the grade should be a verdict PLUS an optional score and note, rather than a
bare boolean. It costs nothing now and means creative work does not need a
second grading system bolted on beside the first.

## Still open

- Does the next worker see the abandoned partial work? Clear about the money,
  silent about the file. If they can use it, the first person worked for free
  rather than merely losing their claim — a different bargain, and one they
  should be told about up front.
- Who grades the approver, once past training and there is no second grader?
  Contest, spot-check and client complaint are the candidates.
- The employment question. Setting rates, defining tasks, timing work,
  qualifying and de-qualifying people, and paying differently by country is a
  lot of control. Whether that carries exposure in Ontario is a question for a
  lawyer, not a guess made here.
