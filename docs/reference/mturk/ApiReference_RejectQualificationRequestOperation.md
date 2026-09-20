> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_RejectQualificationRequestOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# RejectQualificationRequest
<a name="ApiReference_RejectQualificationRequestOperation"></a>

## Description
<a name="ApiReference_RejectQualificationRequestOperation-description"></a>

 The `RejectQualificationRequest` operation rejects a user's request for a Qualification. 

 You can provide a text message explaining why the request was rejected. The Worker who made the request can see this message.

## Request Syntax
<a name="ApiReference_RejectQualificationRequestOperation-request-syntax"></a>

```
{ 
  "QualificationRequestId": {{String}},

  "Reason": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_RejectQualificationRequestOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` QualificationRequestId `  | The ID of the Qualification request, as returned by the [ListQualificationRequests](ApiReference_ListQualificationRequestsOperation.md) operation.<br />Type: String | Yes | 
|  ` Reason `  | A text message explaining why the request was rejected, to be shown to the Worker who made the request.<br />Type: String | No | 

## Response Elements
<a name="ApiReference_RejectQualificationRequestOperation-response-elements"></a>

 A successful request for the `RejectQualificationRequest` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_RejectQualificationRequestOperation-examples"></a>

The following example shows how to use the `RejectQualificationRequest` operation:

### Sample Request
<a name="ApiReference_RejectQualificationRequestOperation-examples-sample-request"></a>

The following example rejects a specified Qualification request.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  QualificationRequestId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE"
}
```

### Sample Response
<a name="ApiReference_RejectQualificationRequestOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```