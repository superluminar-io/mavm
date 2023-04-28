import * as cdk from 'aws-cdk-lib';
import {aws_iam as iam, aws_stepfunctions as sfn, aws_stepfunctions_tasks as tasks, Stack} from 'aws-cdk-lib';
import {Construct} from 'constructs';

export class CleanUpMavmAccountsStack extends Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // POC cleanup root accounts through organization invites

    const MavmGraveyardOu = 'ou-13ix-mzi0cplm';
    const superluminarOrgOVMRole = iam.Role.fromRoleArn(this, 'SuperluminarOrgOVMRole', 'arn:aws:iam::197726340368:role/OVM-invite-move-and-close-account-role');
    const rootOu = 'r-13ix';

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
    });
    const stateInvited = new sfn.Pass(this, "Invited")
      .next(new tasks.CallAwsService(this, 'OrganizationsAcceptHandshakeOnMAVMAccount', {
        service: 'organizations',
        action: 'acceptHandshake',
        credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
        iamResources: ['*'],
        parameters: {
          HandshakeId: sfn.JsonPath.stringAt("$.inviteResponse.Handshake.Id")
        },
        resultPath: sfn.JsonPath.stringAt('$.acceptHandshakeResponse'),
      }).addCatch(new sfn.Pass(this, 'HandshakeAlreadyAccepted')
        .next(moveAccount), {
        errors: ['Organizations.HandshakeConstraintViolationException'],
        resultPath: sfn.JsonPath.stringAt('$.lastError')
      }))
      .next(moveAccount);

    const getExistingHandshake = new tasks.CallAwsService(this, 'OrganizationsGetHandshakeFromMAVMAccount', {
      service: 'organizations',
      action: 'listHandshakesForAccount',
      credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
      iamResources: ['*'],
      resultPath: sfn.JsonPath.stringAt('$.inviteResponse'),
      resultSelector: {
        "Handshake.$": "$.Handshakes[0]",
      }
    });

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
    new sfn.StateMachine(
      this,
      'MAVMInviteAndCleanUpAccounts',
      {
        definition: inviteAccount.addCatch(new sfn.Pass(this, 'HandshakeAlreadyExists')
          .next(getExistingHandshake)
          .next(stateInvited), {
          errors: ["Organizations.DuplicateHandshakeException"],
          resultPath: sfn.JsonPath.stringAt("$.lastError")
        }).next(stateInvited)
      }
    )
  }
}
