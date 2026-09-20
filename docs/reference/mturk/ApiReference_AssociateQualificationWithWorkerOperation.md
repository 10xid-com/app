> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_AssociateQualificationWithWorkerOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# AssociateQualificationWithWorker
<a name="ApiReference_AssociateQualificationWithWorkerOperation"></a>

## Description
<a name="ApiReference_AssociateQualificationWithWorkerOperation-description"></a>

 The `AssociateQualificationWithWorker` operation gives a Worker a Qualification. `AssociateQualificationWithWorker` does not require that the Worker submit a Qualification request. It immediately gives the Worker the Qualification. 

 You can only assign a Qualification of a Qualification type that you created (using the [CreateQualificationType](ApiReference_CreateQualificationTypeOperation.md) operation).

**Tip**  
`AssociateQualificationWithWorker` does not affect any pending Qualification requests for the Qualification by the Worker. If you associate a Qualification to a Worker, then later accept a Qualification request made by the Worker, accepting the request may modify the Qualification score. To resolve a pending Qualification request without affecting the Qualification the Worker already has, reject the request with the [RejectQualificationRequest](ApiReference_RejectQualificationRequestOperation.md) operation. 

## Request Syntax
<a name="ApiReference_AssociateQualificationWithWorkerOperation-request-syntax"></a>

```
{ 
  "QualificationTypeId": {{String}},

  "WorkerId": {{String}},

  "IntegerValue": {{Integer}},

  "SendNotification": {{Boolean}}
 }
```

## Request Parameters
<a name="ApiReference_AssociateQualificationWithWorkerOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` QualificationTypeId `  | The ID of the Qualification type to use for the assigned Qualification.<br />Type: String<br />Constraints: must be a valid Qualification type ID, as returned by the [CreateQualificationType](ApiReference_CreateQualificationTypeOperation.md) operation. | Yes | 
|  ` WorkerId `  | The ID of the Worker to whom the Qualification is being assigned. Worker IDs are included with submitted HIT assignments and Qualification requests.<br />Type: String | Yes | 
|  ` IntegerValue `  | The value of the Qualification to assign.<br />Type: Integer<br />Default: 1 | Yes | 
|  ` SendNotification `  | Specifies whether to send a notification email message to the Worker saying that the qualification was assigned to the Worker.<br />Type: Boolean<br />Default: true | No | 

## Response Elements
<a name="ApiReference_AssociateQualificationWithWorkerOperation-response-elements"></a>

 A successful request for the `AssociateQualificationWithWorker` operation returns with no errors and an empty body. 

## Example
<a name="ApiReference_AssociateQualificationWithWorkerOperation-examples"></a>

The following example shows how to use the `AssociateQualificationWithWorker` operation:

### Sample Request
<a name="ApiReference_AssociateQualificationWithWorkerOperation-examples-sample-request"></a>

The following example grants a Qualification to a Worker.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  WorkerId:"AZ3456EXAMPLE",
  QualificationTypeId:"789RVWYBAZW00EXAMPLE",
  IntegerValue:1,
  SendNotification:false
}
```

### Sample Response
<a name="ApiReference_AssociateQualificationWithWorkerOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
```