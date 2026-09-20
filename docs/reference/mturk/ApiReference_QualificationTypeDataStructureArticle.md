> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationTypeDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# QualificationType
<a name="ApiReference_QualificationTypeDataStructureArticle"></a>

## Description
<a name="ApiReference_QualificationTypeDataStructureArticle-description"></a>

 The QualificationType data structure represents a Qualification type, a description of a property of a Worker that must match the requirements of a HIT for the Worker to be able to accept the HIT. The type also describes how a Worker can obtain a Qualification of that type, such as through a Qualification test. 

 The QualificationType data structure is used as a response element for the following operations: 
+  `CreateQualificationType` 
+  `GetQualificationType` 
+  `ListQualificationTypes` 
+  `UpdateQualificationType` 

## Elements
<a name="ApiReference_QualificationTypeDataStructureArticle-elements"></a>

 The QualificationType structure can contain the elements described in the following table: 


| Name | Description | Required | 
| --- | --- | --- | 
|  `QualificationTypeId`  | A unique identifier for the Qualification type. A Qualification type is given a Qualification type ID when you call the `CreateQualificationType` operation operation, and it retains that ID forever. Can be up to 255 bytes in length. <br />Type: String<br />Default: None | No | 
|  `CreationTime`  | The date and time the Qualification type was created<br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None | No | 
|  `Name`  |  The name of the Qualification type. The type name is used to identify the type, and to find the type using a Qualification type search. <br />Type: String<br />Default: None | No | 
|  `Description`  | A long description for the Qualification type.<br />Type: String<br />Default: None | No | 
|  `Keywords`  |  One or more words or phrases that describe theQualification type, separated by commas. The Keywords make the type easier to find using a search. <br />Type: String<br />Default: None | No | 
|  `QualificationTypeStatus`  |  The status of the Qualification type. A Qualification type's status determines if users can apply to receive a Qualification of this type, and if HITs can be created with requirements based on this type. <br />Type: String<br />Valid Values: Active \| Inactive<br />Default: None | No | 
|  `RetryDelayInSeconds`  |  The amount of time, in seconds, Workers must wait after taking the Qualification test before they can take it again. Workers can take a Qualification test multiple times if they were not granted the Qualification from a previous attempt, or if the test offers a gradient score and they want a better score. <br />Type: positive integer<br /> Default: None. If not specified, retries are disabled and Workers can request a Qualification only once.  | No | 
|  `Test`  |  The questions for a Qualification test associated with this Qualification type that a user can take to obtain a Qualification of this type. <br /> Type: a [QuestionForm](ApiReference_QuestionFormDataStructureArticle.md) data structure.   A Qualification test cannot use an [ExternalQuestionQuestionForm](ApiReference_ExternalQuestionArticle.md) like a HIT can.  <br />Default: None<br /> Constraints: must be specified if `AnswerKey` is present. A Qualification type cannot have both a specified `Test` parameter and an `AutoGranted` value of **true**.  | No | 
|  `TestDurationInSeconds`  |  The amount of time, in seconds, given to a Worker to complete the Qualification test, beginning from the time the Worker requests the Qualification. <br />Type: positive integer<br />Default: None | No | 
|  `AnswerKey`  |  The answers to the Qualification test specified in the `Test` parameter. <br /> Type: an [AnswerKey](ApiReference_AnswerKeyDataStructureArticle.md) data structure. <br /> Default: None. If not provided with a test, the Qualification author must process the Qualification request manually.  | No | 
|  `AutoGranted`  |  Specifies that requests for the Qualification type are granted immediately, without prompting the Worker with a Qualification test. <br />Type: Boolean<br />Valid Values: true \| false<br />Default: None<br /> Constraints: A Qualification type cannot have both a specified `Test` parameter and an `AutoGranted` value of **true**.  | No  | 
|  `AutoGrantedValue`  |  The Qualification value to use for automatically granted Qualifications, if `AutoGranted` is `true`. <br />Type: Integer<br />Default: 1 | No  | 
|  `IsRequestable`  |  Specifies whether the Qualification type is one that a user can request through the Amazon Mechanical Turk web site, such as by taking a Qualification test. This value is **false** for Qualifications assigned automatically by the system. <br />Type: Boolean<br />Valid Values: true \| false<br />Default: None | No  | 

## Example
<a name="ApiReference_QualificationTypeDataStructureArticle-example-"></a>

 The following example shows a QualificationType data structure returned by a call to the `ListQualificationTypes` operation. The `GetQualificationType` operation returns a `QualificationType` element.

```
QualificationType:{
  QualificationTypeId:"789RVWYBAZW00EXAMPLE",
  CreationTime:"2005-01-31T23:59:59Z",
  Name:"EnglishWritingAbility",
  Description:"The ability to write and edit text...",
  Keywords:"English, text, write, edit, language",
  QualificationTypeStatus:"Active",
  RetryDelayInSeconds:86400,
  IsRequestable:true
}
```