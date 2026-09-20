> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_ApproveAssignmentOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# ApproveAssignment
<a name="ApiReference_ApproveAssignmentOperation"></a>

## Description
<a name="ApiReference_ApproveAssignmentOperation-description"></a>

The `ApproveAssignment` operation approves the results of a completed assignment created with the API. 

Approving an assignment initiates two payments from the Requester's Amazon.com account: the Worker who submitted the results is paid the reward specified in the HIT, and Amazon Mechanical Turk fees are debited. If the Requester's account does not have adequate funds for these payments, the call to ApproveAssignment returns an exception, and the approval is not processed. You can include an optional feedback message with the approval, which the Worker can see in the Status section of the web site.

You can also call this operation on assignments that were previous rejected and approve them by over-riding the previous rejection. This works only on rejected assignments that were submitted within the previous 30 days and only if the assignment's related HIT has not been deleted.

**Note**  
To maintain the consistency of the assignments for HITs in a batch, if a HIT is created through the [Amazon Mechanical Turk Requester website](https://requester.mturk.com/create/projects/new), you must use the Requester website UI to approve or reject the work.  
If you want to be able to approve or reject work through the API, you can use a [HITLayout](ApiReference_HITLayoutArticle.md) when calling [CreateHIT](ApiReference_CreateHITOperation.md) to utilize an existing template from the [Amazon Mechanical Turk Requester website](https://requester.mturk.com/create/projects/new) 

## Request Syntax
<a name="ApiReference_ApproveAssignmentOperation-request-syntax"></a>

```
{ 
  "AssignmentId": {{String}},

  "RequesterFeedback": {{String}},

  "OverrideRejection": {{Boolean}}
 }
```

## Request Parameters
<a name="ApiReference_ApproveAssignmentOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` AssignmentId `  | The ID of the assignment. This parameter must correspond to a HIT created by the Requester.<br />Type: String | Yes | 
|  ` RequesterFeedback `  | A message for the Worker, which the Worker can see in the Status section of the web site.<br />Type: String<br />Constraints: Can be up to 1024 characters (including multi-byte characters). The RequesterFeedback parameter cannot contain ASCII characters 0-8, 11,12, or 14-31. If these characters are present, the operation throws an InvalidParameterValue error. | No | 
|  ` OverrideRejection `  | A flag indicating whether you want to approve an assignment that was previously rejected.<br />Type: Boolean<br />Constraints: This works only on rejected assignments that were submitted within the previous 30 days and only if the assignment's related HIT has not been deleted. | No | 

## Response Elements
<a name="ApiReference_ApproveAssignmentOperation-response-elements"></a>

 A successful request for the `ApproveAssignment` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_ApproveAssignmentOperation-examples"></a>

The following example shows how to use the `ApproveAssignment` operation:

### Sample Request
<a name="ApiReference_ApproveAssignmentOperation-examples-sample-request"></a>

The following example approves an assignment identified by its assignment ID.

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
<a name="ApiReference_ApproveAssignmentOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```