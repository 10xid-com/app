> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateWorkerBlockOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# CreateWorkerBlock
<a name="ApiReference_CreateWorkerBlockOperation"></a>

## Description
<a name="ApiReference_CreateWorkerBlockOperation-description"></a>

The `CreateWorkerBlock` operation allows you to prevent a Worker from working on your HITs. For example, you can block a Worker who is producing poor quality work. You can block up to 100,000 Workers.

## Request Syntax
<a name="ApiReference_CreateWorkerBlockOperation-request-syntax"></a>

```
{ 
  "WorkerId": {{String}},

  "Reason": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_CreateWorkerBlockOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` WorkerId `  | The ID of the Worker to block<br />Type: String | Yes | 
|  ` Reason `  | A message that explains the reason for blocking the Worker. The Worker does not see this message.<br />Type: String | No | 

## Response Elements
<a name="ApiReference_CreateWorkerBlockOperation-response-elements"></a>

 A successful request for the `CreateWorkerBlock` operation returns with no errors and an empty body. 