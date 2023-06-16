import * as cdk from 'aws-cdk-lib';
import {aws_iam as iam, aws_stepfunctions as sfn, aws_stepfunctions_tasks as tasks, Stack} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {Table} from "aws-cdk-lib/aws-dynamodb";
import {aliases} from "aws-cdk/lib/commands/docs";

export class CleanUpMavmAccountsStack extends Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        // POC cleanup root accounts through organization invites

        const MavmGraveyardOu = 'ou-13ix-mzi0cplm';
        const superluminarOrgOVMRole = iam.Role.fromRoleArn(this, 'SuperluminarOrgOVMRole', 'arn:aws:iam::197726340368:role/OVM-invite-move-and-close-account-role');
        const rootOu = 'r-13ix';

        const accounts = Table.fromTableName(this, 'MavmAccountsTable', 'account');

        const accountIsHosedUpTerminalState = new sfn.Pass(this, 'AccountIsHosedUp');
        // const accountIsHosedUpTerminalState = new tasks.DynamoUpdateItem(this, 'MarkAccountAsHosedUp', {
        //     key: {
        //         'account_name': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.accountName'))
        //     },
        //     table: accounts,
        //     expressionAttributeValues: {
        //         ':account_status': tasks.DynamoAttributeValue.fromString('DETECTED_AS_HOSED_UP'),
        //         ':hosed_up_detection_date': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
        //     },
        //     updateExpression: 'SET account_status = :account_status, hosed_up_detection_date = :hosed_up_detection_date',
        //     conditionExpression: 'attribute_not_exists(hosed_up_detection_date)',
        // });

        const markAccountAsBuried = new tasks.DynamoUpdateItem(this, 'MarkAccountAsBuried', {
            key: {
                'account_name': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.accountName'))
            },
            table: accounts,
            expressionAttributeValues: {
                ':account_status': tasks.DynamoAttributeValue.fromString('BURIED'),
                ':burial_date': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
            },
            updateExpression: 'SET account_status = :account_status, burial_date = :burial_date',
            conditionExpression: 'attribute_not_exists(burial_date)',
        });

        const listAccountParents = new tasks.CallAwsService(this, 'ListAccountParents', {
            service: 'organizations',
            action: 'listParents',
            credentials: {role: sfn.TaskRole.fromRole(superluminarOrgOVMRole)},
            iamResources: ['*'],
            parameters: {
                ChildId: sfn.JsonPath.stringAt('$.accountId')
            },
            resultPath: sfn.JsonPath.stringAt('$.listParentsResponse'),
        });
        listAccountParents.addRetry({
            errors: ['Organizations.ChildNotFoundException'],
            interval: cdk.Duration.seconds(10),
            maxAttempts: 10,
        });

        const moveAccount = new tasks.CallAwsService(this, 'OrganizationsMoveMAVMAccountToGraveyard', {
            service: 'organizations',
            action: 'moveAccount',
            credentials: {role: sfn.TaskRole.fromRole(superluminarOrgOVMRole)},
            iamResources: ['*'],
            resultPath: sfn.JsonPath.stringAt('$.moveAccountResponse'),
            parameters: {
                AccountId: sfn.JsonPath.stringAt('$.accountId'),
                SourceParentId: rootOu,
                DestinationParentId: MavmGraveyardOu
            }
        }).next(listAccountParents);

        listAccountParents.next(new sfn.Choice(this, 'IsAccountInGraveyardOu?').when(
            sfn.Condition.stringEquals('$.listParentsResponse.Parents[0].Id', MavmGraveyardOu), markAccountAsBuried)
            .otherwise(moveAccount));

        const acceptHandShake = new tasks.CallAwsService(this, 'OrganizationsAcceptHandshakeOnMAVMAccount', {
            service: 'organizations',
            action: 'acceptHandshake',
            credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
            iamResources: ['*'],
            parameters: {
                HandshakeId: sfn.JsonPath.stringAt("$.inviteResponse.Handshake.Id")
            },
            resultPath: sfn.JsonPath.stringAt('$.acceptHandshakeResponse'),
        }).addCatch(new sfn.Pass(this, 'HandshakeAlreadyAccepted')
            .next(listAccountParents), {
            errors: ['Organizations.HandshakeAlreadyInStateException'],
            resultPath: sfn.JsonPath.stringAt('$.lastError')
        }).addCatch(accountIsHosedUpTerminalState, {errors: ['States.TaskFailed']}).next(listAccountParents);

        const stateInvited = new sfn.Pass(this, "Invited")
            .next(new tasks.CallAwsService(this, 'DeleteOrganizationOnMAVMAccount', {
                service: 'organizations',
                action: 'deleteOrganization',
                credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
                iamResources: ['*'],
                resultPath: sfn.JsonPath.stringAt('$.deleteOrganizationResponse'),
            }).addCatch(new sfn.Pass(this, 'OrganizationNotEmptyOrAccountAlreadyBroken').next(accountIsHosedUpTerminalState), {
                errors: ['Organizations.OrganizationNotEmptyException', 'States.TaskFailed'], // Organizations.OrganizationNotEmptyException handle explicitly
                resultPath: sfn.JsonPath.stringAt('$.lastError')
            }).addCatch(new sfn.Pass(this, 'OrganizationNotInUseException').next(acceptHandShake), {
                errors: ['Organizations.AwsOrganizationsNotInUseException'],
                resultPath: sfn.JsonPath.stringAt('$.lastError')
            })
            .next(acceptHandShake));

        const getExistingHandshake = new tasks.CallAwsService(this, 'OrganizationsGetHandshakeFromMAVMAccount', {
            service: 'organizations',
            action: 'listHandshakesForAccount',
            credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
            iamResources: ['*'],
            resultPath: sfn.JsonPath.stringAt('$.inviteResponse'),
            resultSelector: {
                "Handshake.$": "$.Handshakes[0]",
            }
        }).addCatch(accountIsHosedUpTerminalState, {errors:['States.TaskFailed']});

        const inviteAccount = new tasks.CallAwsService(this, 'OrganizationInviteRootAccount', {
            service: 'organizations',
            action: 'inviteAccountToOrganization',
            credentials: {
                role: sfn.TaskRole.fromRole(superluminarOrgOVMRole)
            },
            iamResources: ['*'],
            resultPath: sfn.JsonPath.stringAt('$.inviteResponse'),
            parameters: {
                Target: {
                    Id: sfn.JsonPath.stringAt("$.accountEmail"),
                    Type: 'EMAIL'
                },
                Notes: 'This is a request from MAVM to clean you up!'
            }
        });

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

        const buryAccount = inviteAccount.addCatch(new sfn.Pass(this, 'HandshakeAlreadyExists')
            .next(getExistingHandshake)
            .next(stateInvited), {
            errors: ["Organizations.DuplicateHandshakeException"],
            resultPath: sfn.JsonPath.stringAt("$.lastError")
        }).next(stateInvited);

        queryAccountsToBury.next(new sfn.Map(this, 'MapAccountsToBury', {
            itemsPath: sfn.JsonPath.stringAt('$.queryResponse.Items'),
            parameters: {
                accountId: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_id.S'),
                accountName: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_name.S'),
                accountEmail: sfn.JsonPath.stringAt('$$.Map.Item.Value.account_email.S'),
            },
            maxConcurrency: 1,
            resultPath: sfn.JsonPath.DISCARD
        }).iterator(buryAccount));

        // TODO, skip accounts that are somehow broken
        //States.TaskFailed in step: OrganizationsAcceptHandshakeOnMAVMAccount
        //The role arn:aws:iam::824014778649:role/CleanUpMavmAccountsStack-MAVMInviteAndCleanUpAccou-9VMPYGWK377Z is not authorized to assume the task state's role, arn:aws:iam::054974438228:role/OVMCrossAccountRole.


        new sfn.StateMachine(
            this,
            'MAVMInviteAndCleanUpAccounts',
            {
                definition: queryAccountsToBury,
            }
        )
        //
        // new sfn.StateMachine(
        //     this,
        //     'MAVMInviteAndCleanUpSingleAccount',
        //     {
        //         definition: buryAccount,
        //     }
        // )
    }
}
