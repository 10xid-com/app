> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateHITTypeOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# CreateHITType
<a name="ApiReference_CreateHITTypeOperation"></a>

## Description
<a name="ApiReference_CreateHITTypeOperation-description"></a>

 The `CreateHITType` operation creates a new HIT type.

`CreateHITType` lets you be explicit about which HITs ought to be the same type. It also gives you error checking, to ensure that you call the [CreateHITWithHITType](ApiReference_CreateHITWithHITTypeOperation.md) operation with a valid HIT type ID.

If you register a HIT type with values that match an existing HIT type, the HIT type ID of the existing type will be returned.

## Request Syntax
<a name="ApiReference_CreateHITTypeOperation-request-syntax"></a>

```
{ 
  "Title": {{String}},

  "Description": {{String}},

  "Reward": {{String}},

  "AssignmentDurationInSeconds": {{Integer}},

  "Keywords": {{String}},

  "AutoApprovalDelayInSeconds": {{Integer}},

  "QualificationRequirements": {{QualificationRequirementList}}
 }
```

## Request Parameters
<a name="ApiReference_CreateHITTypeOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` Title `  | The title of the HIT. A title should be short and descriptive about the kind of task the HIT contains. On the Amazon Mechanical Turk web site, the HIT title appears in search results, and everywhere the HIT is mentioned.<br />Type: String | Yes | 
|  ` Description `  | A general description of the HIT. A description includes detailed information about the kind of task the HIT contains. On the Amazon Mechanical Turk web site, the HIT description appears in the expanded view of search results, and in the HIT and assignment screens. A good description gives the user enough information to evaluate the HIT before accepting it.<br />Type: String | Yes | 
|  ` Reward `  | The US Dollar amount the Requester will pay a Worker for successfully completing the HIT.<br />Type: String | Yes | 
|  ` AssignmentDurationInSeconds `  | The amount of time, in seconds, that a Worker has to complete the HIT after accepting it. If a Worker does not complete the assignment within the specified duration, the assignment is considered abandoned. If the HIT is still active (that is, its lifetime has not elapsed), the assignment becomes available for other users to find and accept.<br />Type: Integer | Yes | 
|  ` Keywords `  | One or more words or phrases that describe the HIT, separated by commas. These words are used in searches to find HITs.<br />Type: String | Yes | 
|  ` AutoApprovalDelayInSeconds `  | The number of seconds after an assignment for the HIT has been submitted, after which the assignment is considered Approved automatically unless the Requester explicitly rejects it.<br />Type: Integer | No | 
|  ` QualificationRequirements `  | A condition that a Worker's Qualifications must meet before the Worker is allowed to accept and complete the HIT.<br />Type: [QualificationRequirementList](ApiReference_QualificationRequirementDataStructureArticle.md) | No | 

## Response Elements
<a name="ApiReference_CreateHITTypeOperation-response-elements"></a>

A successful request for the `CreateHITWithHITType` operation returns a HITTypeId. A HITTypeId can be up to 255 bytes long.

## Example
<a name="ApiReference_CreateHITTypeOperation-examples"></a>

The following example shows how to use the `CreateHITType` operation:

### Sample Request
<a name="ApiReference_CreateHITTypeOperation-examples-sample-request"></a>

The following example creates a new HIT type.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  Title:"Compare two photographs",
  Description:"Compare two pictures and pick one",
  Reward:0.5,
  AssignmentDurationInSeconds:0,
  Keywords:"location, photograph, image, identification, opinion"
}
```

### Sample Response
<a name="ApiReference_CreateHITTypeOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  HITTypeId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE"
}
```