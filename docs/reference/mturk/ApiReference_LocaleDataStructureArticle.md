> Archived from https://docs.aws.amazon.com/AWSMechTurk/latest/AWSMturkAPI/ApiReference_LocaleDataStructureArticle.html
> Retrieved 2026-09-20. Amazon Mechanical Turk closes permanently 2026-09-30.
> Archived for reference while designing Flow's work-pool model. Not our content.

---


**Amazon Mechanical Turk will permanently close on September 30, 2026.** For Workers and Requesters currently using the service, visit our [Amazon Mechanical Turk help page](https://www.mturk.com/help) to learn how you can prepare for this closure.

# Locale
<a name="ApiReference_LocaleDataStructureArticle"></a>

## Description
<a name="ApiReference_LocaleDataStructureArticle-description"></a>

 The Locale data structure represents a geographical region or location. 

 The Locale data structure is used as part of the [ QualificationRequirement](ApiReference_QualificationRequirementDataStructureArticle.md) data structure when you specify a requirement based on the locale Qualification, and as part of the [Qualification](ApiReference_QualificationDataStructureArticle.md) data structure that describes the value of a locale Qualification. 

 When used in a QualificationRequirement, the Locale data structure only needs to contain as much of the locale as the Worker needs to match to meet the requirement. For example, a requirement that the Worker be living anywhere in the United States would have only the `Country` field. 

**Note**  
 Currently, a Locale data structure only supports the `Country` field and `Subdivision` field. Please note that subdivisions or states are only available for the United States of America. 

## Elements
<a name="ApiReference_LocaleDataStructureArticle-elements"></a>

 The Locale structure can contain the elements described in the following table. When the structure is used in a request, elements described as **Required** must be included for the request to succeed. 


| Name | Description | Required | 
| --- | --- | --- | 
|  `Country`  | The country of the locale.<br /> Type: A valid [ ISO 3166 country code](https://www.iso.org/iso-3166-country-codes.html). For example, the code **US** refers to the United States of America. <br />Default: none | Yes | 
|  `Subdivision`  | The state or subdivision of the locale.<br /> Type: Type: A valid ISO 3166-2 subdivision code. For example, the code CA refers to the state of California <br />Default: none | No | 

## Example
<a name="ApiReference_LocaleDataStructureArticle-example"></a>

 The following code sample indicates a locale in the United States. 

```
LocaleValue:{
  Country:"US"
}
```

## Example
<a name="ApiReference_LocaleDataStructureArticle-example-subdivision"></a>

 The following code sample indicates a locale in the state of California in the United States of America. 

```
LocaleValue:{
  Country:"US",
  Subdivision:"CA"
}
```