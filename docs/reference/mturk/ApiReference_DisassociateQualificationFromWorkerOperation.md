> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_DisassociateQualificationFromWorkerOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# DisassociateQualificationFromWorker
<a name="ApiReference_DisassociateQualificationFromWorkerOperation"></a>

## Description
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-description"></a>

 The `DisassociateQualificationFromWorker` revokes a previously granted Qualification from a user. 

 You can provide a text message explaining why the Qualification was revoked. The user who had the Qualification can see this message.

## Request Syntax
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-request-syntax"></a>

```
{ 
  "QualificationTypeId": {{String}},

  "WorkerId": {{String}},

  "IntegerValue": {{Integer}},

  "Reason": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` QualificationTypeId `  | The ID of the Qualification type of the Qualification to be revoked.<br />Type: String | Yes | 
|  ` WorkerId `  | The ID of the Worker who possesses the Qualification to be revoked.<br />Type: String | Yes | 
|  ` Reason `  | A text message that explains why the Qualification was revoked. The user who had the Qualification sees this message. IF a reason is not provided, the worker will not be notified.<br />Type: String | No | 

## Response Elements
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-response-elements"></a>

 A successful request for the `DisassociateQualificationFromWorker` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-examples"></a>

The following example shows how to use the `DisassociateQualificationFromWorker` operation:

### Sample Request
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-examples-sample-request"></a>

The following example revokes Qualification of the specified Qualification type for the specified user.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  WorkerId:"AZ3456EXAMPLE",
  QualificationTypeId:"789RVWYBAZW00EXAMPLE"
  IntegerValue:1,
  
}
```

### Sample Response
<a name="ApiReference_DisassociateQualificationFromWorkerOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```