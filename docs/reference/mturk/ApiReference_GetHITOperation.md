> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_GetHITOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# GetHIT
<a name="ApiReference_GetHITOperation"></a>

## Description
<a name="ApiReference_GetHITOperation-description"></a>

The `GetHIT` operation retrieves the details of the specified HIT.

## Request Syntax
<a name="ApiReference_GetHITOperation-request-syntax"></a>

```
{ 
  "HITId": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_GetHITOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` HITId `  | The ID of the HIT.<br />Type: String | Yes | 

## Response Elements
<a name="ApiReference_GetHITOperation-response-elements"></a>

A successful request returns a [HIT](ApiReference_HITDataStructureArticle.md) data structure.