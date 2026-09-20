> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_AssignmentDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# Assignment
<a name="ApiReference_AssignmentDataStructureArticle"></a>

## Description
<a name="ApiReference_AssignmentDataStructureArticle-description"></a>

 The Assignment data structure represents a single assignment of a HIT to a Worker. The assignment tracks the Worker's efforts to complete the HIT, and contains the results for later retrieval. 

 The Assignment data structure is used as a response element for the following operations: 
+ `GetAssignment` 
+ `ListAssignmentsForHIT` 

## Elements
<a name="ApiReference_AssignmentDataStructureArticle-elements"></a>

 The Assignment structure can contain the following elements. 


| Name | Description | Required | 
| --- | --- | --- | 
|  `AssignmentId`  | A unique identifier for the assignment. Can be up to 255 bytes in length.<br />Type: String<br />Default: None | No | 
|  `WorkerId`  |  The ID of the Worker who accepted the HIT. Can be up to 255 bytes in length.<br />Type: String<br />Default: None | No | 
|  `HITId`  | The ID of the HIT. Can be up to 255 bytes in length.<br />Type: String<br />Default: None | No | 
|  `AssignmentStatus`  | The status of the assignment<br />Type: String<br />Valid Values: Submitted \| Approved \| Rejected<br />Default: None | No | 
|  `AutoApprovalTime`  |  If results have been submitted, `AutoApprovalTime` is the date and time the results of the assignment results are considered **Approved** automatically if they have not already been explicitly approved or rejected by the Requester. This value is derived from the auto-approval delay specified by the Requester in the HIT. This value is omitted from the assignment if the Worker has not yet submitted results. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None | No | 
|  `AcceptTime`  | The date and time the Worker accepted the assignment.<br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None | No | 
|  `SubmitTime`  |  If the Worker has submitted results, `SubmitTime` is the date and time the assignment was submitted. This value is omitted from the assignment if the Worker has not yet submitted results. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None | No | 
|  `ApprovalTime`  |  If the Worker has submitted results and the Requester has approved the results, `ApprovalTime` is the date and time the Requester approved the results. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None.<br />**Note**: This value is omitted from the assignment if the Requester has not yet approved the results.  | No | 
|  `RejectionTime`  |  If the Worker has submitted results and the Requester has rejected the results, `RejectionTime` is the date and time the Requester rejected the results. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br /> Default: None. <br />**Note**: This value is omitted from the assignment if the Requester has not yet rejected the results.  | No | 
|  `Deadline`  |  The date and time of the deadline for the assignment. This value is derived from the deadline specification for the HIT and the date and time the Worker accepted the HIT. <br /> Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as **2005-01-31T23:59:59Z**. <br />Default: None | No | 
|  `Answer`  |  The Worker's answers submitted for the HIT contained in a `QuestionFormAnswers` document, if the Worker provides an answer. If the Worker does not provide any answers, `Answer` may contain a `QuestionFormAnswers` document, or `Answer` may be empty.<br /> Type: a [QuestionFormAnswers](ApiReference_QuestionFormAnswersDataStructureArticle.md) data structure <br />Default: None | No | 
|  `RequesterFeedback`  |  The feedback string included with the call to the ` ApproveAssignment` operation or the` RejectAssignment` operation, if the Requester approved or rejected the assignment and specified feedback. <br />Type: String<br /> Default: None | No | 

## Example
<a name="ApiReference_AssignmentDataStructureArticle-example"></a>

 The following example shows an Assignment data structure returned by the `ListAssignmentsForHIT` operation. The `ListAssignmentsForHIT` operation returns zero or more `Assignment` elements for a **Reviewable** HIT. 

```
Assignment:{
	AssignmentId: "123RVWYBAZW00EXAMPLE456RVWYBAZW00EXAMPLE",
	WorkerId:"AZ3456EXAMPLE",
	HITId:"123RVWYBAZW00EXAMPLE",
	AssignmentStatus:"Submitted",
	Deadline: "2005-12-01T23:59:59Z",
	AcceptTime: "2005-12-01T12:00:00Z",
	SubmitTime: "2005-12-07T23:59:59Z",
	Answer:{
		QuestionFormAnswers:{{[XML-encoded Answer data]}}
	}
  }
```