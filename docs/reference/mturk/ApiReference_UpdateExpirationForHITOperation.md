> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_UpdateExpirationForHITOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# UpdateExpirationForHIT
<a name="ApiReference_UpdateExpirationForHITOperation"></a>

## Description
<a name="ApiReference_UpdateExpirationForHITOperation-description"></a>

The `UpdateExpirationForHIT` operation allows you extend the expiration time of a HIT beyond is current expiration or expire a HIT immediately. You cannot shorten the expiration time so that you're not affecting Workers who have accepted your HIT.

 To expire a HIT immediately, provide the value 0 or set ExpireAt to a time in the past. 

## Request Syntax
<a name="ApiReference_UpdateExpirationForHITOperation-request-syntax"></a>

```
{ 
  "HITId": {{String}},

  "ExpireAt": {{Timestamp}}
 }
```

## Request Parameters
<a name="ApiReference_UpdateExpirationForHITOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` HITId `  | The HIT to update.<br />Type: String | Yes | 
|  ` ExpireAt `  | The date and time at which you want the HIT to expire<br />Type: Timestamp | Yes | 

## Response Elements
<a name="ApiReference_UpdateExpirationForHITOperation-response-elements"></a>

 A successful request for the `UpdateExpirationForHIT` operation returns with no errors and an empty body. 