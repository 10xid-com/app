> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationRequestDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# QualificationRequest
<a name="ApiReference_QualificationRequestDataStructureArticle"></a>

## Description
<a name="ApiReference_QualificationRequestDataStructureArticle-description"></a>

 The QualificationRequest data structure represents a request a Worker has made for a Qualification. 

 The QualificationRequest data structure is used as a response element for the following operations: 
+  `ListQualificationRequests` 

## Elements
<a name="ApiReference_QualificationRequestDataStructureArticle-elements"></a>

 The QualificationRequest structure can contain the elements described in the following table: 


| Name | Description | Required | 
| --- | --- | --- | 
|  `QualificationRequestId`  |  The ID of the Qualification request, a unique identifier generated when the request was submitted. Can be up to 255 bytes in length. <br />Type: String<br />Default: None | No | 
|  `QualificationTypeId`  |  The ID of the Qualification type the Worker is requesting, as returned by the `CreateQualificationType` operation. Can be up to 255 bytes in length. <br />Type: String<br />Default: None | No | 
|  `SubjectId`  |  The ID of the Worker requesting the Qualification. This ID corresponds to the `WorkerId` returned with assignment results when the Worker performs a HIT. Can be up to 255 bytes in length. <br />Type: String<br />Default: None | No | 
|  `Test`  |  The contents of the Qualification test that was presented to the Worker, if the type has a test and the Worker has submitted answers. This value is identical to the QuestionForm associated with the Qualification type at the time the Worker requests the Qualification. <br />Type: a [QuestionForm](ApiReference_QuestionFormDataStructureArticle.md) data structure <br />Default: None | No | 
|  `Answer`  |  The Worker's answers for the Qualification type's test contained in a `QuestionFormAnswers` document, if the type has a test and the Worker has submitted answers. If the Worker does not provide any answers, `Answer` may be empty. <br /> Type: a [QuestionFormAnswers](ApiReference_QuestionFormAnswersDataStructureArticle.md) data structure <br />Default: None | No | 
|  `SubmitTime`  |  The date and time the Qualification request had a status of **Submitted**. This is either the time the Worker submitted answers for a Qualification test, or the time the Worker requested the Qualification if the Qualification type does not have a test. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z** <br />Default: None | No | 

## Example
<a name="ApiReference_QualificationRequestDataStructureArticle-example"></a>

 The following example shows a QualificationRequest data structure returned by the `ListQualificationRequests` operation. This operation returns the requests for Qualifications of a Qualification type to the owner of the type. 

```
QualificationRequest:{
  QualificationRequestId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE",
  QualificationTypeId:"789RVWYBAZW00EXAMPLE",
  SubjectId:"AZ3456EXAMPLE",
  Test:{
  	QuestionForm:{{[XML-encoded Question data]}}
	},
	Answer:{
		QuestionFormAnswers:{{[XML-encoded Answer data]}}
	},
  SubmitTime:"2005-12-01T23:59:59Z"
}
```