> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_GetQualificationScoreOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# GetQualificationScore
<a name="ApiReference_GetQualificationScoreOperation"></a>

## Description
<a name="ApiReference_GetQualificationScoreOperation-description"></a>

The `GetQualificationScore` operation returns the value of a Worker's Qualification for a given Qualification type.

To get a Worker's Qualification, you must know the Worker's ID.

Only the owner of a Qualification type can query the value of a Worker's Qualification of that type.

## Request Syntax
<a name="ApiReference_GetQualificationScoreOperation-request-syntax"></a>

```
{ 
  "QualificationTypeId": {{String}},

  "WorkerId": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_GetQualificationScoreOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` QualificationTypeId `  | The ID of the QualificationType.<br />Type: String | Yes | 
|  ` WorkerId `  | The ID of the Worker whose Qualification is being updated.<br />Type: String | Yes | 

## Response Elements
<a name="ApiReference_GetQualificationScoreOperation-response-elements"></a>

A successful request returns a [Qualification](#ApiReference_GetQualificationScoreOperation) data structure.

## Example
<a name="ApiReference_GetQualificationScoreOperation-examples"></a>

The following example shows how to use the `GetQualificationScore` operation:

### Sample Request
<a name="ApiReference_GetQualificationScoreOperation-examples-sample-request"></a>

The following example disposes a Qualification type and any HIT types that are associated with the Qualification type.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  QualificationTypeId:"AZ34EXAMPLE",
  WorkerId:"AZ3456EXAMPLE"
}
```

### Sample Response
<a name="ApiReference_GetQualificationScoreOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  QualificationTypeId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE",
  WorkerId:"AZ3456EXAMPLE",
  IntegerValue:"95",
  GrantTime:"<date>"
}
```