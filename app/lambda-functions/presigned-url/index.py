import json
import os
import boto3

s3_client = boto3.client('s3')
BUCKET_NAME = os.environ['CLAIMS_BUCKET_NAME']

def handler(event, context):
    key = event['queryStringParameters']['key']

    presigned_url = s3_client.generate_presigned_url(
        'put_object',
        Params={'Bucket': BUCKET_NAME, 'Key': key},
        ExpiresIn=30
    )

    return {
        'statusCode': 200,
        'body': json.dumps({'url': presigned_url})
    }
