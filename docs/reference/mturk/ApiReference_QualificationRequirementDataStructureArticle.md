> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_QualificationRequirementDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# QualificationRequirement
<a name="ApiReference_QualificationRequirementDataStructureArticle"></a>

**Topics**
+ [Description](#ApiReference_QualificationRequirementDataStructureArticle-description)
+ [Using Custom, System-Assigned, and Master Qualification Types](#CustomQualificationsandSystemQualifications)
+ [Elements](#ApiReference_QualificationRequirementDataStructureArticle-elements)
+ [Qualification Type IDs](#ApiReference_QualificationType-IDs)
+ [Master Qualification](#MasterQualifications)
+ [Adding Adult Content](#AdultContent)
+ [The Locale Qualification](#ApiReference_QualificationRequirementDataStructureArticle-the-locale-qualification)
+ [Example—Using the QualificationRequirement Data Structure](#ApiReference_QualificationRequirementDataStructureArticle-sample1-createhit)
+ [Example—Using the QualificationRequirement Data Structure for Comparing Multiple Values](#ApiReference_QualificationRequirementDataStructureArticle-sample-createhit)
+ [Example—Using the QualificationRequirement Data Structure to Hide HIT from Unqualified Workers](#ApiReference_QualificationRequirementDataStructureArticle-samplehidden-createhit)

## Description
<a name="ApiReference_QualificationRequirementDataStructureArticle-description"></a>

 The QualificationRequirement data structure describes a Qualification that a Worker must have before the Worker is allowed to accept a HIT. A requirement may optionally state that a Worker must have the Qualification in order to preview the HIT, or see the HIT in search results. 

 The QualificationRequirement data structure is used as a parameter for the following operations: 
+  `CreateHIT` 
+  `CreateHITType` 

 The QualificationRequirement data structure is used in the [HIT data structure](ApiReference_HITDataStructureArticle.md). 

## Using Custom, System-Assigned, and Master Qualification Types
<a name="CustomQualificationsandSystemQualifications"></a>

A Qualification requirement can be based on a Qualification you assign to Workers. You can create a custom Qualification type using the `CreateQualificationType` operation. Then you can grant requests for the Qualification automatically using a Qualification test and answer key submitted with the Qualification type, or you can grant the request manually with the `AcceptQualificationRequest` operation. The `CreateQualificationType` returns a `QualificationTypeId`, which you can use with the `QualificationRequirement` data structure to identify the type of Qualification the Worker is required to have to accept a HIT. Either the Qualification test or your call to `AcceptQualificationRequest` determines a Qualification value, which is compared to the requirement in the HIT to determine the Worker's eligibility. 

Amazon Mechanical Turk supplies several Qualification types for use by all Requesters. Mechanical Turk system-assigned Qualification types work the same way as Qualifications that you create, except that data from the Mechanical Turk marketplace determines the Worker’s values. Every Worker has a value for each system Qualification, and these values are updated as the Worker uses the system. Additionally, Amazon Mechanical Turk also provides Master Qualification types that give you access to an elite group of Workers who have demonstrated superior performance while completing thousands of HITs across the Mechanical Turk marketplace. You can use the Master and system-assigned Qualification types by using the corresponding Qualification type ID in the `QualificationTypeId` element of the `QualificationRequirement` data structure. For a list of the Master and system-assigned IDs, see [Qualification Type IDs](#ApiReference_QualificationType-IDs). For more information about using a Master Qualification type, see [Master Qualification](#MasterQualifications). 

## Elements
<a name="ApiReference_QualificationRequirementDataStructureArticle-elements"></a>

 The QualificationRequirement data structure can contain the following elements. 


| Name | Description | Value | 
| --- | --- | --- | 
|  QualificationTypeId  | The ID of the Qualification type for the requirement. Can be up to 255 bytes in length.  |  A valid QualificationType ID from a custom Qualification type you created or an ID from the list of Master and system-assigned [Qualification Type IDs](#ApiReference_QualificationType-IDs). | 
|  Comparator  |  The kind of comparison to make against a Qualification's value. <br /> You can compare a Qualification's value:+  To an `IntegerValue` to see if it is `LessThan`, `LessThanOrEqualTo`, `GreaterThan`, `GreaterThanOrEqualTo`, `EqualTo`, or `NotEqualTo` the `IntegerValue`.  <br />+  To a `LocaleValue` to see if it is `EqualTo`, or `NotEqualTo` the `LocaleValue`. <br />+  To see if the value is `In` or `NotIn` a set of `IntegerValue` or `LocaleValue` values. <br /> A Qualification requirement can also test if a Qualification `Exists` or `DoesNotExist` in the user's profile, regardless of its value.  |  `LessThan` \| `LessThanOrEqualTo` \| `GreaterThan` \| `GreaterThanOrEqualTo` \| `EqualTo` \| `NotEqualTo` \| `Exists` \| `DoesNotExist` \| `In` \| `NotIn`  | 
|  IntegerValues  | Array of integer values to compare against the Qualification's value. <br /> `IntegerValue` must not be present if `Comparator` is `Exists` or `DoesNotExist`. <br /> `IntegerValue` can only be used if the Qualification type has an integer value; it cannot be used with the `Worker_Locale` QualificationType ID, see [Qualification Type IDs](#ApiReference_QualificationType-IDs).<br /> When performing a set comparison by using the `In` or the `NotIn` comparator, you can use up to 15 elements in this list. For an example of a set comparison, see [Example—Using the QualificationRequirement Data Structure for Comparing Multiple Values](#ApiReference_QualificationRequirementDataStructureArticle-sample-createhit). | An integer.  | 
|  LocaleValue  |  The locale value to compare against the Qualification's value. The local value must be a valid [ ISO 3166 country code](http://www.iso.org/iso/country_codes/iso_3166_code_lists.htm) or supports [ISO 3166-2 subdivisions](http://en.wikipedia.org/wiki/ISO_3166-2:US). <br /> `LocaleValue` can only be used with a `Worker_Locale` QualificationType ID, see [Qualification Type IDs](#ApiReference_QualificationType-IDs). <br /> `LocaleValue` can only be used with the `EqualTo`, `NotEqualTo`, `In`, and `NotIn` comparators. <br /> You must only use a single `LocaleValue` element when using the `EqualTo` or `NotEqualTo` comparators. <br /> When performing a set comparison by using the `In` or the `NotIn` comparator, you can use up to 30 `LocaleValue` elements in a QualificationRequirement data structure. For an example of a set comparison, see [Example—Using the QualificationRequirement Data Structure for Comparing Multiple Values](#ApiReference_QualificationRequirementDataStructureArticle-sample-createhit). | A [Locale](ApiReference_LocaleDataStructureArticle.md) data structure. | 
|  ActionsGuarded  |  Setting this attribute prevents Workers whose Qualifications do not meet this requirement from taking the specified action. <br /> Valid arguments are: +   `Accept` (worker cannot accept the HIT)  <br />+   `PreviewAndAccept` (worker cannot accept or preview the HIT)  <br />+   `DiscoverPreviewAndAccept` (worker cannot accept, preview, or see the HIT in their search results)  <br /> It's possible for you to create a HIT with multiple QualificationRequirements (which can have different values for the ActionGuarded attribute). In this case, the Worker is only permitted to perform an action when they have met all QualificationRequirements guarding the action. The actions in the order of least restrictive to most restrictive is Discover, Preview and Accept. For example, if a Worker meets all QualificationRequirements that are set to DiscoverPreviewAndAccept, but do not meet all requirements that are set with PreviewAndAccept, then the Worker will be able to Discover, i.e. see the HIT in their search result, but will not be able to Preview or Accept the HIT. <br /> The default is `Accept`.  |  Accept \| PreviewAndAccept \| DiscoverPreviewAndAccept  | 
|  RequiredToPreview  |  DEPRECATED as of 03/29/2018 - Use the `ActionsGuarded` field instead. <br /> If **true**, the question data for the HIT will not be shown when a Worker whose Qualifications do not meet this requirement tries to preview the HIT. That is, a Worker's Qualifications must meet all of the requirements for which `RequiredToPreview` is **true** in order to preview the HIT. <br /> If a Worker meets all of the requirements where `RequiredToPreview` is **true** (or if there are no such requirements), but does not meet all of the requirements for the HIT, the Worker will be allowed to preview the HIT's question data, but will not be allowed to accept and complete the HIT. <br /> The default is **false**.  |  A Boolean value, **true** or **false**  | 

## Qualification Type IDs
<a name="ApiReference_QualificationType-IDs"></a>

 The following table lists the Master and system-assigned Qualification Type IDs that can be used in the `QualificationTypeId` element.


|  Name  |  QualificationTypeId  |  Description  | 
| --- | --- | --- | 
| Masters | Sandbox: 2ARFPLSP75KLA8M8DH1HTEQVJT3SY6<br />Production: 2F1QJWKUDD8XADTFD2Q0G6UTO95ALH | Masters are Workers who have demonstrated superior performance while completing thousands of HITs across the Mechanical Turk marketplace. Masters maintain this high level of performance to keep this distinction. Set the `comparator` parameter to "Exists" to require that Workers have this Qualification. <br />Note that for this Qualification type ID, the `QualificationTypeId` value for the Mechanical Turk Sandbox environment is different than the value for the production environment. | 
| Worker\_​NumberHITsApproved |  00000000000000000040  | Specifies the total number of HITs submitted by a Worker that have been approved. The value is an integer greater than or equal to 0.  | 
| Worker\_Locale  |  00000000000000000071  | The location of the Worker, as specified in the Worker's mailing address. For more information about the locale Qualification, see the [The Locale Qualification](#ApiReference_QualificationRequirementDataStructureArticle-the-locale-qualification) section.  | 
| Worker\_Adult |  00000000000000000060  | Requires workers to acknowledge that they are over 18 and that they agree to work on potentially offensive content. The value type is boolean, 1 (required), 0 (not required, the default). | 
|  Worker\_​PercentAssignmentsApproved  |  000000000000000000L0  | The percentage of assignments the Worker has submitted that were subsequently approved by the Requester, over all assignments the Worker has submitted. The value is an integer between 0 and 100. <br />Note that a Worker's approval rate is statistically meaningless for small numbers of assignments, since a single rejection can reduce the approval rate by many percentage points. So to ensure that a new Worker's approval rate is unaffected by these statistically meaningless changes, if a Worker has submitted less than 100 assignments, the Worker's approval rate in the system is 100%.<br />To prevent Workers who have less than 100 approved assignments from working on your HIT, set the Worker\_​NumberHITsApproved qualification type ID to a value greater than 100. | 

## Master Qualification
<a name="MasterQualifications"></a>

You can require that Workers must have a Master Qualification to complete your HITs.

To create a Qualification requirement for Masters, specify:
+  A `QualificationTypeId` of 2F1QJWKUDD8XADTFD2Q0G6UTO95ALH 
+  A `Comparator` of `Exists` 

**Note**  
 The Master Qualification Type ID values used for the `QualificationTypeId` parameter in the preceding procedures are for the production environment. The ID values to use in the Mechanical Turk Sandbox environment are listed in the [Qualification Type IDs](#ApiReference_QualificationType-IDs) table. 

## Adding Adult Content
<a name="AdultContent"></a>

Adult content can be offensive to some people. For that reason, if your HIT is adult-oriented, we ask you to use the following procedure.

**Adding Adult HITs**

1. In the HIT title, include the words "adult content."

1. Specify the worker's qualifications in one of the following ways: 


<table>
<tbody>
  <tr><td>Using the API:<ul><li> Set the <code>CreateHit</code> parameter, <code>QualificationRequirement</code>, to the qualification type, 00000000000000000060. </li><li> Set <code>comparator</code> parameter to "EqualTo."  </li><li>  Set the <code>IntegerValue</code> parameter to 1 (required). </li></ul></td></tr>
  <tr><td></td></tr>
</tbody>
</table>


1. Define the HIT to be private or previewed.

   This setting prevents anyone who does not qualify from seeing the HIT. To make the HIT private, use one of the following methods:


<table>
<tbody>
  <tr><td>Using the API, set the <code>ActionsGuarded</code> parameter to <code>PreviewAndAccept</code>.</td></tr>
  <tr><td>Using the command line tools, in the HIT properties file, set the private parameter, <code>qualification.private</code>, to TRUE. </td></tr>
</tbody>
</table>


## The Locale Qualification
<a name="ApiReference_QualificationRequirementDataStructureArticle-the-locale-qualification"></a>

 You can create a Qualification requirement based on the Worker's location. The Worker's location is specified by the Worker to Amazon Mechanical Turk when the Worker creates his account. 

 To create a Qualification requirement based on the Worker's location, specify: 
+  A `QualificationTypeId` of 00000000000000000071 
+  A `Comparator` of `EqualTo` or `NotEqualTo` 
+  A `LocaleValue` that corresponds to the desired locale 

 To create a Qualification requirement based on the Worker being in or not in one of several locations, specify: 
+  A `QualificationTypeId` of 00000000000000000071 
+  A `Comparator` of `In` or `NotIn` 
+  Multiple `LocaleValue` values that correspond to the desired locales. 

 For more information on the format of a `LocaleValue` element, see [Locale data structure](ApiReference_LocaleDataStructureArticle.md). 

### Example
<a name="ApiReference_QualificationRequirementDataStructureArticle-the-locale-qualification-example"></a>

 The following example shows a QualificationRequirement specifying Workers located in the state of Pennsylvania. Workers located in the state of New York (US-NY) or in the country of India (IN) do not qualify for the HITs with this QualificationRequirement. 

```
QualificationRequirement:{
  	QualificationTypeId:"00000000000000000071",
  	Comparator:"EqualTo",
  	LocaleValues:[{
  		Country:"US",
  		Subdivision:"PA"
	}]
}
```

 The following example shows a QualificationRequirement specifying Workers not located in the state of California. Workers located in the state of New York or in the country of India (IN) will be qualified to do HITs with this QualificationRequirement. 

```
QualificationRequirement:{
  	QualificationTypeId:"00000000000000000071",
  	Comparator:"NotEqualTo",
  	LocaleValues:[{
  		Country:"US",
  		Subdivision:"CA"
	}]
}
```

## Example—Using the QualificationRequirement Data Structure
<a name="ApiReference_QualificationRequirementDataStructureArticle-sample1-createhit"></a>

 The following example of a QualificationRequirement data structure could be passed in to a call to `CreateHIT`. `CreateHIT` accepts parameters that describe the HIT being created, including one or more Qualification requirements: 

```
QualificationRequirement:{
	QualificationTypeId:"789RVWYBAZW00EXAMPLE",
	Comparator:"GreaterThan",
	IntegerValues:[18]
}
```

## Example—Using the QualificationRequirement Data Structure for Comparing Multiple Values
<a name="ApiReference_QualificationRequirementDataStructureArticle-sample-createhit"></a>

 The following example of a QualificationRequirement data structure could be passed in to a call to `CreateHIT`. `CreateHIT` accepts parameters that describe the HIT being created, including one or more Qualification requirements. 

### Example Request
<a name="ApiReference_QualificationRequirementDataStructureArticle-sample-soap-request"></a>

 The following example shows a QualificationRequirement data structure used in a SOAP request that uses multiple `IntegerValue` values when performing a set comparison by using the `In` comparator. 

```
QualificationRequirement:{
  QualificationTypeId:"789RVWYBAZW00EXAMPLE",
  Comparator:"In",
  IntegerValues:[10, 20, 30]
}
```

## Example—Using the QualificationRequirement Data Structure to Hide HIT from Unqualified Workers
<a name="ApiReference_QualificationRequirementDataStructureArticle-samplehidden-createhit"></a>

 The following example of a QualificationRequirement data structure could be passed in to a call to `CreateHIT`. This will hide the HIT from unqualified Workers (these Workers will not be able to accept, preview, or see the HIT in search results). `CreateHIT` accepts parameters that describe the HIT being created, including one or more Qualification requirements: 

```
QualificationRequirement:{
	QualificationTypeId:"789RVWYBAZW00EXAMPLE",
	Comparator:"Exists",
	ActionsGuarded:"DiscoverPreviewAndAccept"
}
```