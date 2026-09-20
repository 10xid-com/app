> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMechanicalTurkRequester/RetrievingResults.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# Retrieving results
<a name="RetrievingResults"></a>

Retrieving the results of a HIT involves gathering the responses from each of the assignment submissions provided by workers. At any point in a HIT's lifecycle (before it is disposed) you can call the [`ListAssignmentsForHIT`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_ListAssignmentsForHITOperation.html) operation to retrieve all of assignments that have been submitted and the answers provided by workers. If the some of the assignments are still awaiting submission by workers, you receive partial results containing the assignments have been submitted so far. 

**Topics**
+ [Assignment attributes](#AssignmentAttributes)
+ [Assignment answer](#AssignmentAnswer)

## Assignment attributes
<a name="AssignmentAttributes"></a>

The `ListAssignmentsForHIT` operation returns an array of zero or more assignments, each captured in an [`Assignment`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_AssignmentDataStructureArticle.html) data structure. The following example shows the data structure that is returned. Each assignment includes the ID of the HIT with which it's associated, the worker who submitted it, and the ID of the assignment itself. The `AssignmentStatus` is one of `Submitted`, `Approved`, or `Rejected`. When a worker first submits an assignment, the status is `Submitted`, and changes based on your decision to approve or reject the assignment. 

```
{
     AssignmentId: "123RVWYBAZW00EXAMPLE456RVWYBAZW00EXAMPLE",
     WorkerId:"AZ3456EXAMPLE",
     HITId:"123RVWYBAZW00EXAMPLE",
     AssignmentStatus:"Submitted",
     AcceptTime: "2019-12-01T12:00:00Z",
     SubmitTime: "2019-12-01T13:04:59Z",
     AutoApprovalTime: "2019-12-04T13:04:59Z",
     Answer:'...'
  }
 
```

The `AcceptTime` and `SubmitTime` indicate when a worker first accepted the task and when they submitted it. This can be used to infer a rough approximation of how long it took the worker to complete the task; however, keep in mind that a worker may step away from their computer for a period of time after accepting a task so the time delta may be inflated. 

The `AutoApprovalTime` indicates when the assignment will be automatically approved if you don't approve or reject it yourself. This is computed by adding the auto-approval delay you set when creating the HIT to the `SubmitTime`. 

## Assignment answer
<a name="AssignmentAnswer"></a>

The `Answer` value is returned as a string containing a [`QuestionFormAnswers`](https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QuestionFormAnswersDataStructureArticle.html) XML data structure. The layout of this data structure corresponds to the HTML form fields you provided in your question HTML. For example, consider the following task form using a standard HTML form element and form field. 

```
<form method='post' id='mturk_form' action='https://www.mturk.com/mturk/externalSubmit'>
  <p>What country do you live in?</p>
  <p><input type="text" name="country"></p>
  <p>Describe the current weather where you live</p>
  <p><textarea name="weather" cols="80" rows="3"></textarea></p>
  <p><input type="submit" id="submitButton" class="btn btn-primary" value="Submit"/></p>
</form>
 
```

The `QuestionFormAnswers` data structure contains an `Answer` value for each form field in your HTML. The `QuestionIdentifier` is the name supplied for the form field in your HTML and the `FreeText` attribute is the value that was entered in the field by the worker. Here the `QuestionIdentifier` values `country` and `weather` match the names specified in the form definition. The `FreeText` values contain the worker's responses. 

```
<?xml version="1.0" encoding="ASCII"?>
<QuestionFormAnswers xmlns="http://mechanicalturk.amazonaws.com/AWSMechanicalTurkDataSchemas/2005-10-01/QuestionFormAnswers.xsd">
  <Answer>
    <QuestionIdentifier>country</QuestionIdentifier>
    <FreeText>United States</FreeText>
  </Answer>
  <Answer>
    <QuestionIdentifier>weather</QuestionIdentifier>
    <FreeText>It's currently raining lightly</FreeText>
  </Answer>
</QuestionFormAnswers>
 
```

 **Assignment Answer when using crowd-form** 

The structure of the answers returned in the `QuestionFormAnswer` data structure is slightly different when using the `crowd-form` element from the Crowd HTML Elements library. Consider the following example that mirrors the preceding one, but replaces `form` with `crowd-form`. 

```
<crowd-form>
  <p>What country do you live in?</p>
  <p><input type="text" name="country"></p>
  <p>Describe the current weather where you live</p>
  <p><textarea name="weather" cols="80" rows="3"></textarea></p>
</ crowd-form>
 
```

The `crowd-form` element collapses all of the form field values into a single `Answer` value in the `QuestionFormAnswer` data structure as shown in the following example. This answer always has the identifier *taskAnswers* and the `FreeText` value is an array of JSON key-value pairs containing the worker answers. 

```
<?xml version="1.0" encoding="ASCII"?>
<QuestionFormAnswers xmlns="http://mechanicalturk.amazonaws.com/AWSMechanicalTurkDataSchemas/2005-10-01/QuestionFormAnswers.xsd">
  <Answer>
    <QuestionIdentifier>taskAnswers</QuestionIdentifier>
    <FreeText>
      [
        {
          "country": "United States", 
          "weather": "It's currently raining lightly"
        }
      ]
    </FreeText>
  </Answer>
</QuestionFormAnswers>
 
```

 ​ 