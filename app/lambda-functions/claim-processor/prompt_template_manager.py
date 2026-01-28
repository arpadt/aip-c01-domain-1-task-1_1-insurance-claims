TEMPLATES = {
    "extract_info": """Extract the following information from this insurance claim document:
- Claimant Name
- Policy Number
- Incident Date
- Claim Amount
- Incident Description

Document:
{document_text}

Return the information in JSON format. You MUST use a predefined format.

Example:

If the extracted information is:

- Claimant Name: John Doe
- Policy Number: 1234
- Incident Date: 01/01/2026
- Claim Amount: $1,500
- Incident Description: An incident ...

then the JSON format MUST look like as follows:

{{
    "claimant_name": "John Doe",
    "policy_number": "1234",
    "incident_date": "01/01/2026",
    "claim_amount": "$1,500",
    "incident_description": "An incident ..."
}}

You MUST ONLY RETURN the JSON object. Every other text is disallowed.""",

    "generate_summary": """Based on this extracted information:
{extracted_info}

Generate a concise summary of the claim."""
}


def get_prompt(template_name, **kwargs):
    template = TEMPLATES.get(template_name)
    if not template:
        raise ValueError(f"Template {template_name} not found")
    return template.format(**kwargs)
