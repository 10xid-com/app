> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_ListReviewableHITsOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# ListReviewableHITs
<a name="ApiReference_ListReviewableHITsOperation"></a>

## Description
<a name="ApiReference_ListReviewableHITsOperation-description"></a>

 The `ListReviewableHITs` operation retrieves the HITs with `Status` equal to **Reviewable** or `Status` equal to **Reviewing** that belong to the Requester calling the operation. Once a HIT has either expired or had the requested number of assignments submitted, it enters the **Reviewable** state. The only ways a HIT can leave the **Reviewable** states are:
+ By being extended, so assignments are once again available on the marketplace.
+ Because `UpdateHITReviewStatus` has updated the status to **Reviewing**.
+ By being disposed, either manually via the `DisposeHIT` operation, or automatically after 120 days.

 You can limit the query to HITs with a specified HIT type. 

 The operation sorts the results, divides them into numbered pages, and returns a single page of results. You can control sorting and pagination can be controlled with parameters to the operation. 

 When (`PageNumber` x `PageSize`) is less than 100, you can get reliable results when you use any of the sort properties. If this number is greater than 100, use the **Enumeration** sort property for best results. The **Enumeration** sort property guarantees that the operation returns all reviewable HITs with no duplicates, but not in any specific order. 

## Request Syntax
<a name="ApiReference_ListReviewableHITsOperation-request-syntax"></a>

```
{ 
  "HITTypeId": {{String}},

  "Status": {{String}},

  "NextToken": {{String}},

  "MaxResults": {{Integer}}
 }
```

## Request Parameters
<a name="ApiReference_ListReviewableHITsOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` HITTypeId `  | The ID of the HIT type of the HITs to consider for the query.<br />Type: String | No | 
|  ` Status `  | The status of the HITs to return: Reviewable \| Reviewing<br />Type: String<br />By Default Status is set to Reviewable. | No | 
|  ` NextToken `  | Pagination token<br />Type: String | No | 
|  ` MaxResults `  | <br />Type: Integer | No | 

## Response Elements
<a name="ApiReference_ListReviewableHITsOperation-response-elements"></a>

A successful request returns a paginated list of [HIT](ApiReference_HITDataStructureArticle.md) data structures.

## Example
<a name="ApiReference_ListReviewableHITsOperation-examples"></a>

The following example shows how to use the `ListReviewableHITs` operation:

### Sample Request
<a name="ApiReference_ListReviewableHITsOperation-examples-sample-request"></a>



```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
}
```

### Sample Response
<a name="ApiReference_ListReviewableHITsOperation-examples-sample-response"></a>

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
  HITs:[HIT]
}
```