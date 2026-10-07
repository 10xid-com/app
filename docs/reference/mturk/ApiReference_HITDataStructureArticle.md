> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_HITDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# HIT
<a name="ApiReference_HITDataStructureArticle"></a>

## Description
<a name="ApiReference_HITDataStructureArticle-description"></a>

 The HIT data structure represents a single HIT, including all the information necessary for a Worker to accept and complete the HIT. 

The HIT data structure is used as a response element for the following operations: 
+ `CreateHIT`
+ `GetHIT`
+ `ListReviewableHITs`
+ `ListHITs`

## Elements
<a name="ApiReference_HITDataStructureArticle-elements"></a>

 The HIT structure can contain the elements described in the following table. 


| Name | Description | Required | 
| --- | --- | --- | 
|  `HITId`  | A unique identifier for the HIT. The `CreateHIT` operation gives a HIT the HIT ID and the HIT retains that ID forever. <br />Type: String<br />Default: None | No | 
|  `HITTypeId`  | The ID of the HIT type of this HIT<br />Type: String<br />Default: None | No | 
|  `HITGroupId`  | The ID of the HIT Group of this HIT<br />Type: String<br />Default: None | No | 
|  `HITLayoutId`  | The ID of the HIT Layout of this HIT <br />Type: String<br />Default: None | No | 
|  `CreationTime`  | The date and time the HIT was created<br />Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as `2012-01-31T23:59:59Z`. <br />Default: None | No | 
|  `Title`  | The title of the HIT<br />Type: String<br />Default: None | No | 
|  `Description`  | A general description of the HIT<br />Type: String<br />Default: None | No | 
|  `Keywords`  |  One or more words or phrases that describe the HIT, separated by commas. Search terms similar to the keywords of a HIT are more likely to have the HIT in the search results. <br />Type: String<br />Default: None | No | 
|  `HITStatus`  | The status of the HIT and its assignments<br />Type: String<br />Valid Values: Assignable \| Unassignable \| Reviewable \| Reviewing \| Disposed<br />Default: None | No | 
|  `Reward`  | The amount of money the Requester will pay a Worker for successfully completing the HIT.<br /> Type: a `Price` data structure <br />Default: None | No | 
|  `LifetimeInSeconds`  | The amount of time, in seconds, after which the HIT is no longer available for users to accept. The HIT becomes unavailable even if the requested number of assignments, specified by `MaxAssignments`, has not been completed. <br />Type: positive integer<br />Default: None | No | 
|  `AssignmentDurationInSeconds`  | The length of time, in seconds, that a Worker has to complete the HIT after accepting it.<br />Type: positive integer<br />Default: None | No | 
|  `MaxAssignments`  | The number of times the HIT can be accepted and completed before the HIT becomes unavailable. <br />Type: positive integer<br />Default: 1 | No | 
|  `AutoApprovalDelayInSeconds`  | The amount of time, in seconds, after the Worker submits an assignment for the HIT that the results are automatically approved by Amazon Mechanical Turk. This is the amount of time the Requester has to reject an assignment submitted by a Worker before the assignment is auto-approved and the Worker is paid.<br />Type: positive integer<br />Default: None | No | 
|  `Expiration`  | The date and time the HIT expires<br />Type: a [dateTime](http://www.w3.org/TR/xmlschema-2/#dateTime) structure in the Coordinated Universal Time (Greenwich Mean Time) time zone, such as `2012-01-31T23:59:59Z`. <br />Default: None | No | 
|  `QualificationRequirement`  | The QualificationRequirement data structure describes a Qualification that a Worker must have before the Worker is allowed to accept a HIT. A requirement may optionally state that a Worker must have the Qualification in order to preview the HIT, or see the HIT in search results. A HIT can have between zero and ten Qualification requirements.<br /> Type: a `QualificationRequirement` data structure. <br />Default: None | No | 
|  `Question`  | The data the Worker completing the HIT uses produce the results.<br />Type: either a [QuestionForm](ApiReference_QuestionFormDataStructureArticle.md) or an [ExternalQuestion ](ApiReference_ExternalQuestionArticle.md) data structure. <br />Default: None | No | 
|  `RequesterAnnotation`  | An arbitrary data field the Requester who created the HIT can use. This field is visible only to the creator of the HIT. <br />Type: String<br />Default: None | No | 
|  `HITReviewStatus`  | Indicates the review status of the HIT.<br />Type: String<br />Valid Values: NotReviewed \| MarkedForReview \| ReviewedAppropriate \| ReviewedInappropriate <br />Default: None | No | 
|  `NumberofAssignmentsPending`  | The number of assignments for this HIT that are being previewed or have been accepted by Workers, but have not yet been submitted, returned, or abandoned. <br />Type: non-negative integer<br />Default: None<br />Conditions: This element is returned only if the `HITAssignmentSummary` response group is specified.  | Conditional | 
|  `NumberofAssignmentsAvailable`  | The number of assignments for this HIT that are available for Workers to accept<br />Type: non-negative integer<br />Default: None<br />Conditions: This element is returned only if the `HITAssignmentSummary` response group is specified.  | Conditional | 
|  `NumberofAssignmentsCompleted`  | The number of assignments for this HIT that have been approved or rejected.<br />Type: non-negative integer<br />Default: None<br />Conditions: This element is returned only if the `HITAssignmentSummary` response group is specified.  | Conditional | 

## Example
<a name="ApiReference_HITDataStructureArticle-example"></a>

 The following example shows a HIT data structure returned by the `CreateHIT` operation. The `CreateHIT` operation returns an element named `HIT` that represents the HIT that was created by the call. 

```
HIT:{
	HITId:"123RVWYBAZW00EXAMPLE",
	HITTypeId:"T100CN9P324W00EXAMPLE",
	HITTypeId:"2005-06-30T23:59:59",
	HITStatus:"Assignable",
	MaxAssignments:"5",
	AutoApprovalDelayInSeconds:"86400",
	LifetimeInSeconds:"86400",
	AssignmentDurationInSeconds:"300",
	Reward:{
		Amount:"25"
		CurrencyCode:"USD"
		FormattedPrice:"$0.25"
	},
	Title:"Location and Photograph Identification",
	Description:"Select the image that best represents...",
	Keywords:"location, photograph, image, identification, opinion",
	Question:{
		QuestionForm:{{[XML-encoded Question data]}}
	},
	QualificationRequirement:{
		QualificationTypeId:"789RVWYBAZW00EXAMPLE",
		Comparator:"GreaterThan",
		Value:"18"
	},
	HITReviewStatus:"NotReviewed"
}
```