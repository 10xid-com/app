> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_ListWorkerBlocksOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# ListWorkerBlocks
<a name="ApiReference_ListWorkerBlocksOperation"></a>

## Description
<a name="ApiReference_ListWorkerBlocksOperation-description"></a>

The `ListWorkersBlocks` operation retrieves a list of Workers who are blocked from working on your HITs.

## Request Syntax
<a name="ApiReference_ListWorkerBlocksOperation-request-syntax"></a>

```
{ 
  "NextToken": {{String}},

  "MaxResults": {{Integer}}
 }
```

## Request Parameters
<a name="ApiReference_ListWorkerBlocksOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` NextToken `  | Pagination token<br />Type: String | No | 
|  ` MaxResults `  | <br />Type: Integer | No | 

## Response Elements
<a name="ApiReference_ListWorkerBlocksOperation-response-elements"></a>

A successful request returns a paginated list of Workers that have been blocked along with the reason for the block.

## Example
<a name="ApiReference_ListWorkerBlocksOperation-examples"></a>

The following example shows how to use the `ListWorkerBlocks` operation:

### Sample Request
<a name="ApiReference_ListWorkerBlocksOperation-examples-sample-request"></a>

The following example lists all Worker blocks.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
}
```

### Sample Response
<a name="ApiReference_ListWorkerBlocksOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  WorkerBlocks:[{WorkerId, Reason}],
  NumResults:3
}
```