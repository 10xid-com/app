> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_AcceptQualificationRequestOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# AcceptQualificationRequest
<a name="ApiReference_AcceptQualificationRequestOperation"></a>

## Description
<a name="ApiReference_AcceptQualificationRequestOperation-description"></a>

 The `AcceptQualificationRequest` operation grants a Worker's request for a Qualification. 

 Only the owner of the Qualification type can grant a Qualification request for that type.

## Request Syntax
<a name="ApiReference_AcceptQualificationRequestOperation-request-syntax"></a>

```
{ 
  "QualificationRequestId": {{String}},

  "IntegerValue": {{Integer}}
 }
```

## Request Parameters
<a name="ApiReference_AcceptQualificationRequestOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` QualificationRequestId `  | The ID of the Qualification request, as returned by the [ListQualificationRequests](ApiReference_ListQualificationRequestsOperation.md) operation.<br />Type: String. | Yes | 
|  ` IntegerValue `  | The value of the Qualification. You can omit this value if you are using the presence or absence of the Qualification as the basis for a HIT requirement.<br />Type: Integer<br />Default: 1 | No | 

## Response Elements
<a name="ApiReference_AcceptQualificationRequestOperation-response-elements"></a>

 A successful request for the `AcceptQualificationRequest` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_AcceptQualificationRequestOperation-examples"></a>

The following example shows how to use the `AcceptQualificationRequest` operation:

### Sample Request
<a name="ApiReference_AcceptQualificationRequestOperation-examples-sample-request"></a>

The following example grants a Qualification to a user.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  QualificationRequestId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE",
  IntegerValue:95
}
```

### Sample Response
<a name="ApiReference_AcceptQualificationRequestOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```