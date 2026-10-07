> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_RejectAssignmentOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# RejectAssignment
<a name="ApiReference_RejectAssignmentOperation"></a>

## Description
<a name="ApiReference_RejectAssignmentOperation-description"></a>

The `RejectAssignment` operation rejects the results of a completed assignment.

You must include a feedback message with the rejection, which the Worker can see in the Status section of the web site. When you include a feedback message with the rejection, it helps the Worker understand why the assignment was rejected, and can improve the quality of the results the Worker submits in the future.

Only the Requester who created the HIT can reject an assignment for the HIT.

**Note**  
To maintain the consistency of the assignments for HITs in a batch, if a HIT is created through the [Amazon Mechanical Turk Requester website](https://requester.mturk.com/create/projects/new), you must use the Requester website UI to approve or reject the work.  
If you want to be able to approve or reject work through the API, you can use a [HITLayout](ApiReference_HITLayoutArticle.md) when calling [CreateHIT](ApiReference_CreateHITOperation.md) to utilize an existing template from the [Amazon Mechanical Turk Requester website](https://requester.mturk.com/create/projects/new) 

## Request Syntax
<a name="ApiReference_RejectAssignmentOperation-request-syntax"></a>

```
{ 
  "AssignmentId": {{String}},

  "RequesterFeedback": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_RejectAssignmentOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` AssignmentId `  | The ID of the assignment. This parameter must correspond to a HIT created by the Requester.<br />Type: String | Yes | 
|  ` RequesterFeedback `  | A message for the Worker, which the Worker can see in the Status section of the web site.<br />Type: String<br />Constraints: Can be up to 1024 characters (including multi-byte characters). The RequesterFeedback parameter cannot contain ASCII characters 0-8, 11,12, or 14-31. If these characters are present, the operation throws an InvalidParameterValue error. | Yes | 

## Response Elements
<a name="ApiReference_RejectAssignmentOperation-response-elements"></a>

 A successful request for the `RejectAssignment` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_RejectAssignmentOperation-examples"></a>

The following example shows how to use the `RejectAssignment` operation:

### Sample Request
<a name="ApiReference_RejectAssignmentOperation-examples-sample-request"></a>

The following example rejects an assignment identified by its assignment ID.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  AssignmentId:"123RVWYBAZW00EXAMPLE456RVWYBAZW00EXAMPLE"
}
```

### Sample Response
<a name="ApiReference_RejectAssignmentOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```