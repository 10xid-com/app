> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# CreateHIT
<a name="ApiReference_CreateHITOperation"></a>

## Description
<a name="ApiReference_CreateHITOperation-description"></a>

The `CreateHIT` operation creates a new [HIT](ApiReference_HITDataStructureArticle.md) (Human Intelligence Task). The new HIT is made available for Workers to find and accept on the Amazon Mechanical Turk website. 

 This operation allows you to specify a new HIT by passing in values for the properties of the HIT, such as its title, reward amount and number of assignments. When you pass these values to `CreateHIT`, a new HIT is created for you, with a new `HITTypeID`.

CreateHIT also supports several ways to provide question data: by providing a value for the [Question](ApiReference_QuestionAnswerDataArticle.md) parameter that fully specifies the contents of the HIT, or by providing a [HitLayoutId](ApiReference_HITLayoutArticle.md) and associated `HitLayoutParameters`.

For a step-by-step tutorial, please read our [blog post](https://blog.mturk.com/tutorial-a-beginners-guide-to-crowdsourcing-ml-training-data-with-python-and-mturk-d8df4bdf2977) which walks you through the HIT creation process.

**Note**  
If a HIT is created with 10 or more maximum assignments, there is an additional fee. For more information, see [Amazon Mechanical Turk Pricing](https://requester.mturk.com/pricing).
During the first few seconds after calling `CreateHIT`, the HIT cannot be modified except to expire it using `UpdateExpirationForHIT`. Until the HIT becomes modifiable, the following operations may return a RequestError:  
 `UpdateHITTypeOfHIT`, `CreateAdditionalAssignmentsForHIT`, and `UpdateExpirationForHIT` with a DateTime in the future.

## Request Syntax
<a name="ApiReference_CreateHITOperation-request-syntax"></a>

```
{ 
  "Title": {{String}},

  "Description": {{String}},

  "Question": {{String}},

  "HITLayoutId": {{String}},

  "HITLayoutParameters": {{HITLayoutParameterList}},

  "Reward": {{String}},

  "AssignmentDurationInSeconds": {{Integer}},

  "LifetimeInSeconds": {{Integer}},

  "Keywords": {{String}},

  "MaxAssignments": {{Integer}},

  "AutoApprovalDelayInSeconds": {{Integer}},

  "QualificationRequirements": {{QualificationRequirementList}},

  "AssignmentReviewPolicy": {{ReviewPolicy}},

  "HITReviewPolicy": {{ReviewPolicy}},

  "RequesterAnnotation": {{String}},

  "UniqueRequestToken": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_CreateHITOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` Title `  | The title of the HIT. A title should be short and descriptive about the kind of task the HIT contains. On the Amazon Mechanical Turk web site, the HIT title appears in search results, and everywhere the HIT is mentioned.<br />Type: String | Yes | 
|  ` Description `  | A general description of the HIT. A description includes detailed information about the kind of task the HIT contains. On the Amazon Mechanical Turk web site, the HIT description appears in the expanded view of search results, and in the HIT and assignment screens. A good description gives the user enough information to evaluate the HIT before accepting it.<br />Type: String | Yes | 
|  ` Question `  | The data the person completing the HIT uses to produce the results. You can learn more about the various ways of specifying this field [here](ApiReference_QuestionAnswerDataArticle.md)<br />Type: String<br />Constraints: The XML question data must not be larger than 64 kilobytes (65,535 bytes) in size, including whitespace. Either a Question parameter or a HITLayoutId parameter must be provided. | No | 
|  ` HITLayoutId `  | The HITLayoutId allows you to use a pre-existing HIT design with placeholder values and create an additional HIT by providing those values as HITLayoutParameters. For more information, see [here](ApiReference_HITLayoutArticle.md).<br />Type: String<br />Constraints: Either a Question parameter or a HITLayoutId parameter must be provided. | No | 
|  ` HITLayoutParameters `  | If the HITLayoutId is provided, any placeholder values must be filled in with values using the HITLayoutParameter structure. For more information, see HITLayout.<br />Type: [HITLayoutParameterList](ApiReference_HITLayoutParameterArticle.md) | No | 
|  ` Reward `  | The US Dollar amount the Requester will pay a Worker for successfully completing the HIT.<br />Type: String | Yes | 
|  ` AssignmentDurationInSeconds `  | The amount of time, in seconds, that a Worker has to complete the HIT after accepting it. If a Worker does not complete the assignment within the specified duration, the assignment is considered abandoned. If the HIT is still active (that is, its lifetime has not elapsed), the assignment becomes available for other users to find and accept.<br />Type: Integer | Yes | 
|  ` LifetimeInSeconds `  | An amount of time, in seconds, after which the HIT is no longer available for users to accept. After the lifetime of the HIT elapses, the HIT no longer appears in HIT searches, even if not all of the assignments for the HIT have been accepted.<br />Type: Integer | Yes | 
|  ` Keywords `  | One or more words or phrases that describe the HIT, separated by commas. These words are used in searches to find HITs.<br />Type: String | Yes | 
|  ` MaxAssignments `  | The number of times the HIT can be accepted and completed before the HIT becomes unavailable.<br />Type: Integer | Yes | 
|  ` AutoApprovalDelayInSeconds `  | The number of seconds after an assignment for the HIT has been submitted, after which the assignment is considered Approved automatically unless the Requester explicitly rejects it.<br />Type: Integer | No | 
|  ` QualificationRequirements `  | A condition that a Worker's Qualifications must meet before the Worker is allowed to accept and complete the HIT.<br />Type: [QualificationRequirementList](ApiReference_QualificationTypeDataStructureArticle.md) | No | 
|  ` AssignmentReviewPolicy `  | The Assignment-level Review Policy applies to the assignments under the HIT. You can specify for Mechanical Turk to take various actions based on the policy.<br />Type: [ReviewPolicy](ApiReference_HITReviewPolicyDataStructureArticle.md) | No | 
|  ` HITReviewPolicy `  | The HIT-level Review Policy applies to the HIT. You can specify for Mechanical Turk to take various actions based on the policy.<br />Type: [ReviewPolicy](ApiReference_HITReviewPolicyDataStructureArticle.md) | No | 
|  ` RequesterAnnotation `  | An arbitrary data field. The RequesterAnnotation parameter lets your application attach arbitrary data to the HIT for tracking purposes. For example, this parameter could be an identifier internal to the Requester's application that corresponds with the HIT. The RequesterAnnotation parameter for a HIT is only visible to the Requester who created the HIT. It is not shown to the Worker, or any other Requester. The RequesterAnnotation parameter may be different for each HIT you submit. It does not affect how your HITs are grouped.<br />Type: String <br />Constraints: must not be longer than 255 characters in length. | No | 
|  ` UniqueRequestToken `  | A unique identifier for this request. Allows you to retry the call on error without creating duplicate HITs. This is useful in cases such as network timeouts where it is unclear whether or not the call succeeded on the server. If the HIT already exists in the system from a previous call using the same UniqueRequestToken, subsequent calls will return a AWS.MechanicalTurk.HitAlreadyExists error with a message containing the HITId.<br />Type: String<br />Constraints: must not be longer than 64 characters in length. It is your responsibility to ensure uniqueness of the token. The unique token expires after 24 hours. Subsequent calls using the same UniqueRequestToken made after the 24 hour limit could create duplicate HITs. | No | 

## Response Elements
<a name="ApiReference_CreateHITOperation-response-elements"></a>

A successful request for the CreateHIT operation returns [HIT](ApiReference_HITDataStructureArticle.md) object containing the newly created HIT data.

## Example
<a name="ApiReference_CreateHITOperation-examples"></a>

The following example shows how to use the `CreateHIT` operation:

### Sample Request
<a name="ApiReference_CreateHITOperation-examples-sample-request"></a>

The following example creates a simple HIT. The Question parameter takes a block of XML data as its value.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  Title:"Compare two photographs",
  Description:"Compare two pictures and pick one",
  Reward:0.5,
  Question:[XML question data],
  AssignmentDurationInSeconds:0,
  LifetimeInSeconds:604800,
  Keywords:"location, photograph, image, identification, opinion"
}
```

**Tip**  
Find code samples for MTurk Requester API at [AWSLabs on Github](https://github.com/awslabs/mturk-code-samples)

### Sample Response
<a name="ApiReference_CreateHITOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  HITId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE",
  HITTypeId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE"
}
```