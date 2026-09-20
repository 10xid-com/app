> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_GetAssignmentOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# GetAssignment
<a name="ApiReference_GetAssignmentOperation"></a>

## Description
<a name="ApiReference_GetAssignmentOperation-description"></a>

The `GetAssignment` retrieves an assignment with an AssignmentStatus value of Submitted, Approved, or Rejected, using the assignment's ID. Requesters can only retrieve their own assignments for HITs that they have not disposed of.

## Request Syntax
<a name="ApiReference_GetAssignmentOperation-request-syntax"></a>

```
{ 
  "AssignmentId": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_GetAssignmentOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` AssignmentId `  | The ID of the assignment you want to retrieve<br />Type: String | Yes | 

## Response Elements
<a name="ApiReference_GetAssignmentOperation-response-elements"></a>

A successful request returns an [Assignment](ApiReference_AssignmentDataStructureArticle.md) data structure.