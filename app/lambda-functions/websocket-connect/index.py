import os
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['CLAIMS_TABLE_NAME'])

def handler(event, context):
    connection_id = event['requestContext']['connectionId']
    table.put_item(Item={
        'PK': 'CONNECTIONS',
        'SK': f'CONNECTION#{connection_id}',
        'Type': 'ConnectionId',
        'ConnectionId': connection_id
    })
    return {'statusCode': 200}
