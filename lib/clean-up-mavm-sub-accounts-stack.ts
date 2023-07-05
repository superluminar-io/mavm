import * as cdk from "aws-cdk-lib";
import {aws_stepfunctions as sfn, aws_stepfunctions_tasks as tasks, Stack} from "aws-cdk-lib";
import {Construct} from "constructs";
import {Table} from "aws-cdk-lib/aws-dynamodb";

export class CleanUpMavmSubAccountsStack extends Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const accounts = Table.fromTableName(this, 'MavmAccountsTable', 'account');

    const queryAccountsToBury = new tasks.CallAwsService(this, 'QueryAccountsToBury', {
      service: 'dynamodb',
      action: 'query',
      iamResources: ['*'],
      parameters: {
        TableName: accounts.tableName,
        IndexName: 'account_status',
        KeyConditionExpression: 'account_status = :account_status',
        ExpressionAttributeValues: {
          ':account_status': {S: 'VENDED'}
        }
      },
      resultPath: sfn.JsonPath.stringAt('$.queryResponse'),
    });

    const allGoodNothingTodo = new sfn.Succeed(this, 'AllGoodNothingToDo');

    new sfn.StateMachine(
      this,
      'CleanUpAccounts',
      {
        definition: queryAccountsToBury.next(
          new sfn.Map(this, 'MapRootAccounts', {
            itemsPath: sfn.JsonPath.stringAt('$.queryResponse.Items'),
            parameters: {
              accountId: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_id.S'),
              accountName: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_name.S'),
              accountEmail: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_email.S'),
            },
            maxConcurrency: 1,
            resultPath: sfn.JsonPath.DISCARD
          }).iterator(new tasks.CallAwsService(this, 'OrganizationsListAccounts', {
            service: 'organizations',
            action: 'listAccounts',
            credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
            iamResources: ['*'],
            resultSelector: {Accounts: sfn.JsonPath.stringAt('$..Accounts[?(@.Status==ACTIVE)]')}, // to ignore already suspended accounts
            resultPath: sfn.JsonPath.stringAt('$.subAccounts'),
          }).addCatch(new sfn.Pass(this, 'RootAccountIsMissingOrganization').next(allGoodNothingTodo), {
            errors: ["Organizations.AwsOrganizationsNotInUseException"],
            resultPath: sfn.JsonPath.stringAt("$.error")
          }).addCatch(new sfn.Choice(this, 'IsNotAuthorizedToAssumeOVMCrossAccountRole')
            .when(sfn.Condition.stringMatches("$.error.Cause", "The role * is not authorized to assume the task state's role, arn:aws:iam::*:role/OVMCrossAccountRole."),
              allGoodNothingTodo)
            .otherwise(new sfn.Fail(this, "UnknownFailure")), {
            errors: ["States.TaskFailed"],
            resultPath: sfn.JsonPath.stringAt("$.error")
          })
            .next(new sfn.Choice(this, 'HasSubAccounts?')
              .when(sfn.Condition.isPresent(sfn.JsonPath.stringAt("$.subAccounts.Accounts[1]")), // to check if there are more than the root account in the array
                new sfn.Map(this, 'MapSubAccounts', {
                  maxConcurrency: 1, // to avoid running into rate-limits on the close account API
                  itemsPath: sfn.JsonPath.stringAt('$.subAccounts.Accounts'),
                  parameters: {
                    subAccountId: sfn.JsonPath.stringAt("$$.Map.Item.Value.Id"),
                    rootAccountId: sfn.JsonPath.stringAt("$.accountId")
                  },
                }).iterator(
                  new sfn.Choice(this, 'SubAccountIdEqualsRootAccountId?')
                    .when(sfn.Condition.stringEqualsJsonPath(sfn.JsonPath.stringAt('$.rootAccountId'), sfn.JsonPath.stringAt('$.subAccountId')),
                      new sfn.Pass(this, 'SkipRootAccount')
                    )
                    .otherwise(new tasks.CallAwsService(this, 'OrganizationsCloseAccounts', {
                      service: 'organizations',
                      action: 'closeAccount',
                      credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.rootAccountId)")},
                      iamResources: ['*'],
                      parameters: {
                        AccountId: sfn.JsonPath.stringAt("$.subAccountId")
                      }
                    }).addCatch(new sfn.Pass(this, 'GracefullySkipAccountClosing'), {
                      errors: ["Organizations.TooManyRequestsException", "Organizations.AccountAlreadyClosedException"]
                    }))
                ))
              .otherwise(allGoodNothingTodo)))
        ),
      }
    )
  }
}