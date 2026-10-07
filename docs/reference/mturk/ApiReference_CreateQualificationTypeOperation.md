> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_CreateQualificationTypeOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# CreateQualificationType
<a name="ApiReference_CreateQualificationTypeOperation"></a>

## Description
<a name="ApiReference_CreateQualificationTypeOperation-description"></a>

 The `CreateQualificationType` operation creates a new Qualification type, which is represented by a [QualificationType](ApiReference_QualificationTypeDataStructureArticle.md) data structure.

## Request Syntax
<a name="ApiReference_CreateQualificationTypeOperation-request-syntax"></a>

```
{ 
  "Name": {{String}},

  "Description": {{String}},

  "Keywords": {{String}},

  "RetryDelayInSeconds": {{Non-negative integer}},

  "QualificationTypeStatus": {{String}},

  "Test": {{String}},

  "AnswerKey": {{String}},

  "TestDurationInSeconds": {{Integer}},

  "AutoGranted": {{Boolean}},

  "AutoGrantedValue": {{Integer}}
 }
```

## Request Parameters
<a name="ApiReference_CreateQualificationTypeOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` Name `  |  The name you give to the Qualification type. The type name is used to represent the Qualification to Workers, and to find the type using a Qualification type search. It must be unique across all of your Qualification types.<br />Type: String | Yes | 
|  ` Description `  | A long description for the Qualification type. On the Amazon Mechanical Turk website, the long description is displayed when a Worker examines a Qualification type.<br />Type: String<br />Constraints: Must be less than or equal to 2000 characters | Yes | 
|  ` Keywords `  | One or more words or phrases that describe the Qualification type, separated by commas. The keywords of a type make the type easier to find during a search.<br />Type: String<br />Constraints: Must be less than or equal to 1000 characters, including commas and spaces. | No | 
|  ` RetryDelayInSeconds `  | The number of seconds that a Worker must wait after requesting a Qualification of the Qualification type before the worker can retry the Qualification request.<br />Type: Non-negative integer<br />Default: None. If not specified, retries are disabled and Workers can request a Qualification of this type only once, even if the Worker has not been granted the Qualification. It is not possible to disable retries for a Qualification type after it has been created with retries enabled. If you want to disable retries, you must delete existing retry-enabled Qualification type and then create a new Qualification type with retries disabled. | No | 
|  ` QualificationTypeStatus `  | The initial status of the Qualification type.<br />Type: String<br />Constraints: Valid values are: Active \| Inactive | Yes | 
|  ` Test `  | The questions for the Qualification test a Worker must answer correctly to obtain a Qualification of this type. If this parameter is specified, `TestDurationInSeconds` must also be specified.<br />Type: String<br />Constraints: Must not be longer than 65535 bytes. Must be a QuestionForm data structure. This parameter cannot be specified if AutoGranted is true.<br />Default: None. If not specified, the Worker may request the Qualification without answering any questions. | No | 
|  ` AnswerKey `  | The answers to the Qualification test specified in the Test parameter, in the form of an AnswerKey data structure.<br />Type: String<br />Constraints: Must not be longer than 65535 bytes.<br />Default: None. If not specified, you must process Qualification requests manually. | No | 
|  ` TestDurationInSeconds `  | The number of seconds the Worker has to complete the Qualification test, starting from the time the Worker requests the Qualification.<br />Type: Integer | Conditional: required when a Test is specified. | 
|  ` AutoGranted `  | Specifies whether requests for the Qualification type are granted immediately, without prompting the Worker with a Qualification test.<br />Type: Boolean<br />Constraints: If the Test parameter is specified, this parameter cannot be true.<br />Default: False | No | 
|  ` AutoGrantedValue `  | The Qualification value to use for automatically granted Qualifications. This parameter is used only if the AutoGranted parameter is true.<br />Type: Integer<br />Default: 1 when used with AutoGranted. None when AutoGranted is not specified. | No | 

## Response Elements
<a name="ApiReference_CreateQualificationTypeOperation-response-elements"></a>

A successful request for the CreateQualificationType operation returns a [QualificationType](ApiReference_QualificationTypeDataStructureArticle.md) data structure.

## Example
<a name="ApiReference_CreateQualificationTypeOperation-examples"></a>

The following example shows how to use the `CreateQualificationType` operation:

### Sample Request
<a name="ApiReference_CreateQualificationTypeOperation-examples-sample-request"></a>

The following example creates a Qualification type.

```
POST / HTTP/1.1
Host: mturk-requester.us-east-1.amazonaws.com
Content-Length: <PayloadSizeBytes>
X-Amz-Date: <Date>
{
  Name:"EnglishWritingAbility",
  Description:"The ability to write and edit in text in English",
  QualificationTypeStatus:"Active"
}
```

### Sample Response
<a name="ApiReference_CreateQualificationTypeOperation-examples-sample-response"></a>

The following is an example response:

```
HTTP/1.1 200 OK
x-amzn-RequestId: <RequestId>
Content-Type: application/x-amz-json-1.1
Content-Length: <PayloadSizeBytes>
Date: <Date>
{
  QualificationTypeId:"789RVWYBAZW00EXAMPLE951RVWYBAZW00EXAMPLE",
  Name:"EnglishWritingAbility",
  Description:"The ability to write and edit in text in English",
  QualificationTypeStatus:"Active"
}
```