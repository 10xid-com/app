> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMechanicalTurkRequester/mturk-hits-attributes.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# HIT attributes
<a name="mturk-hits-attributes"></a>

When you create a task (HIT) with Amazon Mechanical Turk (Mechanical Turk), you provide a number of attributes about the task that tell Mechanical Turk how to display it in the marketplace. These are separate from the content and question of the task itself, and include the title, description, reward amount, and attributes describing how long the task will remain active. 

 The attributes can be grouped as follows. 

**Descriptive attributes**
+  `Title` 
+  `Description` 
+  `Keywords` 

**Reward time-related attributes**
+  `AssignmentDurationInSeconds` 
+  `AutoApprovalDelayInSeconds` 
+  `LifetimeInSeconds` 

**`MaxAssignments` `QualificationRequirements`**

The first six attributes (`Title`, `Description`, `Keywords`, `Reward`, `AssignmentDurationInSeconds`, and `AutoApprovalDelayInSeconds`) and `QualificationRequirements` comprise the *HIT Type* for the task. The HIT Type attributes are common across a group of HITs and allow the Mechanical Turk marketplace to group tasks together that have the same HIT Type. When workers complete a task, they can immediately start on the next task with the same HIT Type. 

 When you call the `[CreateHIT](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITOperation.html)` API and provide these values, Mechanical Turk first attempts to find an existing HIT Type that has the same values for these attributes. If one doesn't exist, then a new HIT Type is created. Alternatively, you can call [`CreateHITType`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITTypeOperation.html) with these attributes to directly create a HIT Type and then use the resulting HIT Type ID to create HITs using the [`CreateHITWithHITType`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITWithHITTypeOperation.html) API. 

** `Title`, `Description`, and `Keywords`**

These should provide a clear description of the task to be completed, as well as any relevant search keywords that help workers find your task. 

**`Reward`**

The amount that is transferred to the worker when the task is approved. This is in US dollars and should be provided to the API as a string. For example, to set the reward for a HIT at 10 cents, the value would be "0.10". 

`AssignmentDurationInSeconds `

`AssignmentDurationInSeconds` is the amount of time that workers have to complete the task. For example, if you create a HIT that has an `AssignmentDurationInSeconds` of 300 it expires after 5 minutes. If a worker does not complete it in that time, it is be assigned to a new worker. 

You should specify a duration that is long enough that a worker can still complete it even if they run into difficulties. However, don't set it to be overly long, as this can result in an assignment becoming orphaned for the duration of the time. Setting a long assignment duration can also discourage workers from accepting it if workers believe the amount of time required is significantly out of line with the reward amount. 

 **Auto-approval delay **

After a worker submits an aAssignment, you have the option to *approve* or *reject* their work. However, if the amount of time specified by the `AutoApprovalDelayInSeconds` elapses, then it is automatically approved. Timely approval or rejection of worker submissions is important to workers as it directly influences how quickly they get paid for the tasks they complete. As such, you should strive to review work shortly after it is submitted and set the auto-approval delay as low as possible so that workers don't have to wait inordinately long if you fail to approve some assignments. To automatically approve all work that is submitted, you can set the auto-approval delay to 0. 

**Lifetime **

`LifetimeInSeconds` is the maximum amount of time that a HIT is available to be accepted in the Mechanical Turk marketplace. If the lifetime expires before all of the available assignments have been accepted, it is removed from the marketplace. Note that if the lifetime expires after a worker accepts an assignment, the worker can still submit a response up until the assignment duration expires. 

**Max Assignments **

`MaxAssignments` specifies the maximum number of workers that can submit responses for a HIT. 

**Qualification Requirements **

`QualificationRequirements` can be used to manage which workers can view and accept a HIT. More information on using qualification requirements can be found in [Managing workers](ManagingWorkers.md). 