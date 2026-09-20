> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# Qualification
<a name="ApiReference_QualificationDataStructureArticle"></a>

## Description
<a name="ApiReference_QualificationDataStructureArticle-description"></a>

 The Qualification data structure represents a Qualification assigned to a user, including the Qualification type and the value (score). 

 The Qualification data structure is used as a response element for the following operations: 
+  `GetQualificationScore` 
+  `ListQualificationRequests` 

## Elements
<a name="ApiReference_QualificationDataStructureArticle-elements"></a>

 The Qualification structure can contain the elements described in the following table. When the structure is used in a request, elements described as **Required** must be included for the request to succeed. 


| Name | Description | Required | 
| --- | --- | --- | 
|  `QualificationTypeId`  | The ID of the Qualification type for the Qualification. Can be up to 255 bytes in length.<br />Type: String<br />Default: None | Yes | 
|  `WorkerId`  | The ID of the Worker who possesses the Qualification. Can be up to 255 bytes in length.<br />Type: String<br />Default: None | Yes | 
|  `GrantTime`  |  The date and time the Qualification was associated with the Worker. If the Worker's Qualification was revoked, and then re-associated based on a new Qualification request, `GrantTime` is the date and time of the last call to the AssociateQualificationWithWorker operation. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z** <br />Default: None | Yes | 
|  `IntegerValue`  | The value (score) of the Qualification, if the Qualification has an integer value.<br />Type: Integer<br />Default: None | No | 
|  `LocaleValue`  |  The value of the Qualification if the Qualification describes a geographical region or location. <br /> Type: a [Locale](ApiReference_LocaleDataStructureArticle.md) data structure. <br />Default: None | No | 
|  `Status`  | The status of the Qualification<br />Type: String<br />Valid Values: Granted \| Revoked<br />Default: None | Yes | 

## Example
<a name="ApiReference_QualificationDataStructureArticle-example"></a>

 The following example illustrates a Qualification with an integer value. 

```
Qualification:{
  QualificationTypeId:"789RVWYBAZW00EXAMPLE",
  WorkerId:"AZ3456EXAMPLE",
  GrantTime:"2005-01-31T23:59:59Z",
  IntegerValue:95
}
```