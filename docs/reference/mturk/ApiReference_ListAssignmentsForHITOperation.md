> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_ListAssignmentsForHITOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# ListAssignmentsForHIT
<a name="ApiReference_ListAssignmentsForHITOperation"></a>

## Description
<a name="ApiReference_ListAssignmentsForHITOperation-description"></a>

The `ListAssignmentsForHIT` operation retrieves completed assignments for a HIT. You can use this operation to retrieve the results for a HIT. 

 You can get assignments for a HIT at any time, even if the HIT is not yet Reviewable. If a HIT requested multiple assignments, and has received some results but has not yet become Reviewable, you can still retrieve the partial results with this operation. 

 Use the AssignmentStatuses parameter to control which set of assignments for a HIT are returned. The GetAssignmentsForHIT operation can return submitted assignments awaiting approval, or it can return assignments that have already been approved or rejected. You can set AssignmentStatuses=Approved,Rejected to get assignments that have already been approved and rejected together in one result set. 

 Only the Requester who created the HIT can retrieve the assignments for that HIT. 

 Results are sorted and divided into numbered pages and the operation returns a single page of results. You can use the parameters of the operation to control sorting and pagination. 

## Request Syntax
<a name="ApiReference_ListAssignmentsForHITOperation-request-syntax"></a>

```
{ 
  "HITId": {{String}},

  "AssignmentStatuses": {{String}},

  "NextToken": {{String}},

  "MaxResults": {{Integer}}
 }
```

## Request Parameters
<a name="ApiReference_ListAssignmentsForHITOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` HITId `  | The ID of the HIT.<br />Type: String | Yes | 
|  ` AssignmentStatuses `  | The status of the assignments to return: Submitted \| Approved \| Rejected<br />Type: String | No | 
|  ` NextToken `  | Pagination token<br />Type: String | No | 
|  ` MaxResults `  | <br />Type: Integer | No | 

## Response Elements
<a name="ApiReference_ListAssignmentsForHITOperation-response-elements"></a>

A successful request returns a paginated list of [Assignment](ApiReference_AssignmentDataStructureArticle.md) data structures submitted for the HIT.

## Example
<a name="ApiReference_ListAssignmentsForHITOperation-examples"></a>

The following example shows how to use the `ListAssignmentsForHIT` operation:

### Sample Request
<a name="ApiReference_ListAssignmentsForHITOperation-examples-sample-request"></a>



```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
}
```

### Sample Response
<a name="ApiReference_ListAssignmentsForHITOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  NextToken:{{PaginationToken}},
  NumResults:10,
  Assignments:[Assignment]
}
```