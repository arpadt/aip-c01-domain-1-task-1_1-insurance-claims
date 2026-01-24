import boto3
import json
import os

# Initialize clients
s3 = boto3.client('s3')
bedrock_runtime = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')

model_id = os.environ['EXTRACTION_MODEL_ID']
claims_table_name = os.environ['CLAIMS_TABLE_NAME']

claims_table = dynamodb.Table(claims_table_name)

def handler(event, context):
    # Get document from S3
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']

    try:
        s3_response = s3.get_object(Bucket=bucket, Key=key)
        document_text = s3_response['Body'].read().decode('utf-8')
    except Exception as e:
        print(f'Error processing document {key} from bucket {bucket}: {e}')
        raise

    # Create prompt for information extraction
    prompt = f"""
    Extract the following information from this insurance claim document:
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
    """

    # Invoke Bedrock model
    try:
        extraction_response = bedrock_runtime.invoke_model(
            modelId=model_id,
            body=json.dumps({
                "schemaVersion": "messages-v1",
                "messages": [{
                    "role": "user",
                    "content": [{"text": prompt}]
                }],
                "inferenceConfig": {
                    "maxTokens": 1000,
                    "temperature": 0.0
                }
            })
        )
    except Exception as e:
        print(f'Error extracting info from claims document: {e}')
        raise

    # Parse response
    extraction_response_body = json.loads(extraction_response['body'].read())
    extracted_info = json.loads(extraction_response_body['output']['message']['content'][0]['text'])
    print('extracted info: ', extracted_info)

    # Generate summary
    summary_prompt = f"""
    Based on this extracted information:
    {extracted_info}

    Generate a concise summary of the claim.
    """

    try:
        summary_response = bedrock_runtime.invoke_model(
            modelId=model_id,
            body=json.dumps({
                "schemaVersion": "messages-v1",
                "messages": [{
                    "role": "user",
                    "content": [{"text": summary_prompt}]
                }],
                "inferenceConfig": {
                    "maxTokens": 500,
                    "temperature": 0.7
                }
            })
        )
    except Exception as e:
        print(f'Error while summarizing the claim: {e}')
        raise

    summary_body = json.loads(summary_response['body'].read())
    summary = summary_body['output']['message']['content'][0]['text']
    print('summary: ', summary)

    try:
        claimant_name = extracted_info['claimant_name']
        policy_number = extracted_info['policy_number']

        ddb_response = claims_table.put_item(Item={
            'PK': f'CLAIMANTNAME#{claimant_name}',
            'SK': f'POLICY_NUMBER#{policy_number}',
            'Summary': summary,
        })
        print('dynamodb response: ', ddb_response)
    except Exception as e:
        print('Error while persisting summary: {e}')
        raise
