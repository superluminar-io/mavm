import {
  aws_iam as iam,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks, Duration,
  Stack,
  StackProps
} from "aws-cdk-lib";
import {Construct} from "constructs";
import {StateMachine, WaitTime} from "aws-cdk-lib/aws-stepfunctions";
import {Table} from "aws-cdk-lib/aws-dynamodb";


export class SuspendBuriedAccountsStack extends Stack {

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const superluminarOrgOVMRole = iam.Role.fromRoleArn(this, 'SuperluminarOrgOVMRole', 'arn:aws:iam::197726340368:role/OVM-invite-move-and-close-account-role');

    const accounts = Table.fromTableName(this, 'MavmAccountsTable', 'account');

    const suspendBuriedAccounts = new tasks.CallAwsService(this, 'QueryBuriedAccounts', {
      service: 'dynamodb',
      action: 'query',
      iamResources: ['*'],
      parameters: {
        TableName: accounts.tableName,
        IndexName: 'account_status',
        KeyConditionExpression: 'account_status = :account_status',
        ExpressionAttributeValues: {
          ':account_status': {S: 'BURIED'}
        }
      },
      resultPath: sfn.JsonPath.stringAt('$.queryResponse'),
    });

    const markAccountAsSuspended = new tasks.DynamoUpdateItem(this, 'MarkAccountAsSuspended', {
      key: {
        'account_name': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.accountName'))
      },
      table: accounts,
      expressionAttributeValues: {
        ':account_status': tasks.DynamoAttributeValue.fromString('BURIED_AND_CLOSED'),
        ':buried_and_close_date': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      updateExpression: 'SET account_status = :account_status, buried_and_close_date = :buried_and_close_date',
      conditionExpression: 'attribute_not_exists(buried_and_close_date)',
    });

    const suspendAccount = new tasks.CallAwsService(this, 'SuspendAccount', {
      service: 'organizations',
      action: 'closeAccount',
      credentials: {role: sfn.TaskRole.fromRole(superluminarOrgOVMRole)},
      iamResources: ['*'],
      parameters: {
        AccountId: sfn.JsonPath.stringAt('$.accountId'),
      },
      resultPath: sfn.JsonPath.stringAt('$.closeAccountResponse'),
    }).addCatch(markAccountAsSuspended, {
      errors: ['Organizations.AccountAlreadyClosedException'],
      resultPath: sfn.JsonPath.stringAt('$.lastError'),
    }).addCatch(new sfn.Succeed(this, 'Exceeded the number of requests'), {
      errors: ['Organizations.TooManyRequestsException'],
      resultPath: sfn.JsonPath.stringAt('$.lastError'),
    }).addCatch(new sfn.Choice(this, 'HandleCloseAccountErrorWithReason')
        .when(sfn.Condition.stringMatches(sfn.JsonPath.stringAt('$.lastError.Reason'), 'CloseAccountRequestsLimitExceeded'),
          new sfn.Succeed(this, 'Exceeded the number of member accounts you can close concurrently.'))
        .when(sfn.Condition.stringMatches(sfn.JsonPath.stringAt('$.lastError.Reason'), 'CloseAccountQuotaExceeded'),
          new sfn.Succeed(this, 'Exceeded the number of member accounts you can close in a 30 day period.'))
        .otherwise(markAccountAsSuspended), {
      errors: ['Organizations.ConstraintViolationException'],
      resultPath: sfn.JsonPath.stringAt('$.lastError'),
    })
      .next(markAccountAsSuspended);

    suspendBuriedAccounts.next(new sfn.Map(this, 'MapBuriedAccounts', {
      itemsPath: sfn.JsonPath.stringAt('$.queryResponse.Items'),
      parameters: {
        accountId: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_id.S'),
        accountName: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_name.S'),
        accountEmail: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_email.S'),
      },
      maxConcurrency: 1,
    }).iterator(
      new sfn.Wait(this, 'WaitALittle', {time: WaitTime.duration(Duration.seconds(20))}) // a rough estimate to avoid throttling
        .next(suspendAccount)));

    new StateMachine(this, 'SuspendBuriedAccountsStateMachine', {
      definition: suspendBuriedAccounts,
    })
  }
}