> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_SendBonusOperation.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# SendBonus
<a name="ApiReference_SendBonusOperation"></a>

## Description
<a name="ApiReference_SendBonusOperation-description"></a>

The `SendBonus` operation issues a payment of money from your account to a Worker. This payment happens separately from the reward you pay to the Worker when you approve the Worker's assignment. The SendBonus operation requires the Worker's ID and the assignment ID as parameters to initiate payment of the bonus. You must include a message that explains the reason for the bonus payment, as the Worker may not be expecting the payment. Amazon Mechanical Turk collects a fee for bonus payments, similar to the HIT listing fee.

 This operation fails if your account does not have enough funds to pay for both the bonus and the fees. This operation may also fail if the Worker in question has not completed an Assignment for you in the last six months.

## Request Syntax
<a name="ApiReference_SendBonusOperation-request-syntax"></a>

```
{ 
  "WorkerId": {{String}},

  "AssignmentId": {{String}},

  "BonusAmount": {{String}},

  "Reason": {{String}},

  "UniqueRequestToken": {{String}}
 }
```

## Request Parameters
<a name="ApiReference_SendBonusOperation-request-parameters"></a>

 The request accepts the following data in JSON format: 


| Name | Description | Required | 
| --- | --- | --- | 
|  ` WorkerId `  | The ID of the Worker being paid the bonus.<br />Type: String | Yes | 
|  ` AssignmentId `  | The ID of the assignment for which this bonus is paid.<br />Type: String | Yes | 
|  ` BonusAmount `  | The bonus is specified as a US Dollar amount.<br />Type: String | Yes | 
|  ` Reason `  | A message that explains the reason for the bonus payment. The Worker receiving the bonus can see this message.<br />Type: String | Yes | 
|  ` UniqueRequestToken `  | A unique identifier for this request, which allows you to retry the call on error without granting multiple bonuses. This is useful in cases such as network timeouts where it is unclear whether or not the call succeeded on the server. If the bonus already exists in the system from a previous call using the same UniqueRequestToken, subsequent calls will return an error with a message containing the request ID.<br />Type: String<br />Constraints: must not be longer than 64 characters in length. | No | 

## Response Elements
<a name="ApiReference_SendBonusOperation-response-elements"></a>

 A successful request for the `SendBonus` operation returns with no errors and an empty body. 