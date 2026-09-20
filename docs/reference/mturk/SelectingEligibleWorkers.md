> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMechanicalTurkRequester/SelectingEligibleWorkers.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# Selecting eligible workers
<a name="SelectingEligibleWorkers"></a>

By default, all tasks (HITs) posted to Amazon Mechanical Turk (Mechanical Turk) are available to all active workers in the Mechanical Turk marketplace. You can restrict the audience that's eligible for your HITs by adding qualification requirements. Qualification requirements can be used to both restrict the audience to workers that meet certain criteria, or exclude those that have certain attributes. These requirements operate on attributes that are assigned to workers as *qualifications.* Qualifications can be assigned by the Mechanical Turk system or requesters, and are visible to workers in their account. 

**Topics**
+ [Qualifications and qualification types](#QualsAndQualTypes)
+ [Qualification requirements](#QualRequirements)
+ [System qualification types](#SystemQualTypes)

## Qualifications and qualification types
<a name="QualsAndQualTypes"></a>

Qualification types are system- or requester-defined descriptions of an attribute that can be associated with a worker. One example is the system-generated qualification type `NumberHITsApproved`, which measures the number of HITs a worker has submitted and had approved. Another would be a requester-defined qualification type that tracks how accurate a worker has been on previous tasks that the requester has posted. 

When a qualification type is assigned to a worker, it is applied as a *qualification* for that worker. In the case of the system-generated `NumberHITsApproved` qualification type, a qualification is automatically created for a worker as the work they submit is approved. For custom qualification types, a requester can assign the qualification to a worker using the [`AssociateQualificationWithWorker`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_AssociateQualificationWithWorkerOperation.html) operation and optionally providing an integer value to associate with it. 

## Qualification requirements
<a name="QualRequirements"></a>

A requirement is defined when calling either `CreateHIT` or `CreateHITType`. Either operation accepts an array of one or more [`QualificationRequirement`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationRequirementDataStructureArticle.html) data structures to specify the qualifications workers must have to be eligible for your HIT. 

The `QualificationRequirement` data structure comprises four attributes: `QualificationTypeId`, `Comparator`, value (either `IntegerValues` or `LocaleValues`), and `ActionsGuarded`. The `QualificationTypeId` specifies the qualification type that should be applied and can be either the ID of an Mechanical Turk system qualification type, or one you create in your account. The `Comparator` and value are then used to evaluate if the worker has the required qualification attributes to be eligible for the HIT. Finally, the `ActionsGuarded` indicates the level of visibility that a HIT has to workers that aren't eligible to accept it. 

The `Comparator` attribute specifies how the qualification type is evaluated and is typically used with a value. The following table illustrates the values that can be used for `Comparator` and the required value attribute, if any. The existence `Comparators` don't require a value attribute since they are only used to evaluate if the qualification type has been assigned, not the value that has been associated with it. 



| Type  | Values  | Required value attribute  |  Example  | 
| --- | --- | --- | --- | 
|  Existence  |  Exists  |  None  | Only include workers that have been assigned the qualification type, regardless of value.  | 
|  ​  |  DoesNotExist  |  None  | Exclude workers that have been assigned the qualification type.  | 
|  Numeric  |  LessThan  |  IntegerValues  | Only include workers that have been assigned the qualification type where the assigned value is less than 50.  | 
|  ​  |  LessThanOrEqualTo  |  IntegerValues  | Only include workers that have been assigned the qualification type where the assigned value is less than or equal to 50.  | 
|  ​  | GreaterThan |  IntegerValues  |  Only include Workers that have been assigned the Qualification Type where the assigned value is greater than 50.  | 
|  ​  |  GreaterThanOrEqualTo |  IntegerValues  | Only include workers that have been assigned the qualification type where the assigned value is greater than or equal to 50.  | 
|  Equivalence  |  EqualTo  |  IntegerValues or LocaleValues  | Only include workers located in Spain.  | 
|  ​  |  NotEqualTo  |  IntegerValues or LocaleValues  | Only include workers who have been assigned the qualification type where the assigned value is not 42.  | 
|  Set  |  In  |  IntegerValues or LocaleValues  | Only include workers who have been assigned the qualification type where the assigned value is 1, 2, 3 or 8.  | 
|  ​  |  NotIn  |  IntegerValues or LocaleValues  | Only include workers who are not located in the US States of Florida and Georgia.  | 

 ​ 

The `ActionsGuarded` attribute indicates the level of visibility that your HIT has to workers who aren't eligible for it. This defaults to `Accept`, which indicates that ineligible workers can't accept it, but they can see it in the Mechanical Turk marketplace and preview the task if they wish so that they can request a qualification to work on the HIT if they wish to. If you want to prevent them from previewing it, you can set the `ActionsGuarded` to `PreviewAndAccept`; they can then see it in their list of available tasks and request any custom qualifications. Finally, `DiscoverPreviewAndAccept` hides the HIT from ineligible workers. 

The `CreateHIT` and `CreateHITType` operations accept an array of qualification requirements which can include one or more qualification requirement data structures so you cano apply multiple requirements to workers to be eligible for your task. Because workers must meet *all* of the requirements, be careful to ensure that the requirements do not conflict. For example, if you had a qualification requirement that specified workers must be located in the US and a second requirement that they be located in canada, it would be impossible for any worker to meet both criteria. If your goal is to include workers in either the US or Canada, you would need replace the two requirements with a single requirement using the *`In`* `Comparator` to restrict workers to those in an array containing both the US and Canada. 

## System qualification types
<a name="SystemQualTypes"></a>

The most commonly used qualification types are those provided by Mechanical Turk. These include the following: 
+ A *HITs approved* qualification for the number of HITs that workers have successfully completed in the past, which can be used to identify workers with more or less experience. 
+ An *Approval Percentage* qualification to specify workers that you have approved at a specified rate on previous tasks. 
+ A *Locale* qualification to select workers in specific countries or US states. 
+ A *Masters* qualification that is awarded to workers that have demonstrated superior performance over a period of time across thousands of HITs. 
+ An *Adult* qualification that selects workers who have indicated they are over 18 years of age and are willing to work on potentially offensive content. 

Each of these qualification types has an associated `QualificationTypeId` which can be found in the documentation for [`QualificationRequirement`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationRequirementDataStructureArticle.html#ApiReference_QualificationType-IDs). 

### Using the HITs Approved qualification type
<a name="HITApprovedQualType"></a>

The `NumberHITsApproved` qualification type restricts tasks to workers with more or less experience based on their past work on Mechanical Turk.  For example, if you only wanted to use workers who were relatively new to the platform and had successfully submitted fewer than 500 HITs, you would use the following value for `QualificationRequirements`. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000040',
    Comparator: 'LessThan',
    IntegerValues: [500]
  }
]
```

If, instead, you wanted more experienced workers who had successfully completed 100 HITs, you would use the following. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000040',
    Comparator: ' GreaterThanOrEqualTo',
    IntegerValues: [100]
  }
]
```

### Using the Masters qualification type
<a name="MastersQualType"></a>

The Masters qualification type is a Mechanical Turk–managed qualification type that is assigned to workers when they have demonstrated superior performance over a period of time across thousands of HITs. There is no value associated with it, so you can simply use the `Exists` comparator to apply it to your tasks. 

Note that there is an additional fee for using the Masters qualification on your task as described in [Mechanical Turk Pricing](https://www.mturk.com/pricing). 

```
QualificationRequirements: [
  {
    QualificationTypeId: '2F1QJWKUDD8XADTFD2Q0G6UTO95ALH',
    Comparator: 'Exists'
  }
]
```

### Using the Percentage Approved type
<a name="PercentageApprovedQualType"></a>

The `PercentAssignmentsApproved` qualification type restricts tasks based on how often you have approved or rejected past work a worker has done for you. For example, to only accept workers that have an approval rate of greater than or equal to 95%, the following qualification requirement would be included in your [`CreateHIT`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITOperation.html) calls. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '000000000000000000L0',
    Comparator: 'GreaterThanOrEqualTo',
    IntegerValues: [95]
  }
]
```

Note that a worker's approval rate is statistically meaningless for small numbers of assignments, since a single rejection can reduce the approval rate by many percentage points. To ensure that a new worker's approval rate is unaffected by these statistically meaningless changes, if a worker has submitted fewer than 100 assignments for you, the worker's approval rate is 100%. 

### Using the Locale qualification type
<a name="LocaleApprovedQualType"></a>

Locale is a Mechanical Turk qualification type that specifies the workers that are eligible for your task based on where they are located. To use Locale, you must specify one or more `LocaleValues` using a JSON data structure that includes a `Country` attribute and can optionally include a `Subdivision` attribute. The `Country` attribute should specify the two-character country code of the country. The `Subdivision` attribute is only supported when the `Country` is "US" and should specify the two-character state code for the US state. The following example would restrict workers to those in the US state of Minnesota. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000071',
    Comparator: 'EqualTo',
    LocaleValues: [
      {
          Country: "US",
          Subdivision: "MN"
     }
    ]
  }
]
 
```

To select multiple locations, you should use the `In` comparator and a list of locales as shown in the following example, which restricts the task to workers in the US and Canada. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000071',
    Comparator: 'In',
    LocaleValues: [
      { Country: "US" },
      { Country: "CA" }
    ]
  }
]
 
```

Use caution when using multiple Locale qualification requirements in the same HIT. If the requirements above were split into two requirements, one for the US and one for CA, no norkers could accept the task. However, using two Locale requirements is a good way to restrict workers to the US but exclude selected states. The following would include all workers in the US with the exception of workers in Florida and Georgia. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000071',
    Comparator: 'Equals,
    LocaleValues: [
      { Country: "US" }
    ]
  },
  {
    QualificationTypeId: '00000000000000000071',
    Comparator: 'NotIn,
    LocaleValues: [
      { Country: "US", Subdivision: 'FL'},
      { Country: "US", Subdivision: 'GA'}
    ]
  }
]
 
```

### Objectionable content
<a name="ObjectionableContent"></a>

Some tasks, such as image moderation, involve handling content that some workers might find objectionable, typically because it involves imagery that contains violence or nudity. If there is the potential that some of your HITs may contain objectionable content, you should make use of the Adult qualification type. This restricts the task to workers who have confirmed they are over 18 years of age and are willing to view potentially objectionable content. The qualification requirement should also specify an `ActionsGuarded` value of `PreviewAndAccept` or `DiscoverPreviewAndAccept`. 

```
QualificationRequirements: [
  {
    QualificationTypeId: '00000000000000000060',
    Comparator: 'Equals',
    IntegerValues: [1],
    ActionsGuarded: 'PreviewAndAccept'
  }
]
 
```

In addition, you should include "(WARNING: This HIT may contain adult content. Worker discretion is advised.)" in the title of your HIT. 

### Custom qualification type
<a name="CustomQualType"></a>

Requester-defined qualification types can also be created to handle a range of needs in managing who can work on your tasks. Information on how to create and use custom qualification types can be found in [Working with custom qualification types](WorkWithCustomQualType.md).