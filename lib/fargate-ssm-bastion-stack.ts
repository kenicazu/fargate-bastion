import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as aws_ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";

export class FargateSsmBastionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // VPCの定義
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    
    // ECSに必要なエンドポイントの設定
    vpc.addInterfaceEndpoint("ecr-endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR
    });
    
    vpc.addInterfaceEndpoint("ecr-dkr-endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER
    });
    
    vpc.addInterfaceEndpoint("logs-endpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });
    
    vpc.addGatewayEndpoint("s3-endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        {
          subnets: vpc.isolatedSubnets
        }
      ]
    });
    
    // ECS-Exec/SSMに必要なエンドポイントの設定
    vpc.addInterfaceEndpoint("SSMEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
    });
    
    vpc.addInterfaceEndpoint("SSMMessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    });
    
    vpc.addInterfaceEndpoint("EC2MessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
    });
    
    
    // Databaseの設定
    const database = new rds.DatabaseCluster(this, "AuroraPostgre", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_15_2 }),
      defaultDatabaseName: "bastiontest",
      instances:1,
      instanceProps: {
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      },
    });
    
    
    //ECS Cluster
    const cluster = new aws_ecs.Cluster(this, "BastionCluster", {
      clusterName: "BastionCluster",
      vpc: vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });
    
    
    // ECS Exec Role
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
  
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      })
    );
    
    // ECS タスク定義
    const executionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });
    const taskDefinition = new aws_ecs.FargateTaskDefinition(this, "bastion", {
      taskRole,
      executionRole
    });
    
    const DockerAsset = new DockerImageAsset(this, 'BusyBoxAsset', {
      directory: path.join(__dirname, '../docker/busybox'),
    });
    
    const container = taskDefinition.addContainer("nginx", {
       image: aws_ecs.ContainerImage.fromDockerImageAsset(DockerAsset),
      //portMappings: [{ containerPort: 1053 }],
    });
    
    
    // ECS サービス作成
    const bastionHostSG = new ec2.SecurityGroup(this, "BastionHostSG", {
      vpc,
      allowAllOutbound: true,
    });
    
    bastionHostSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
     );
    const ecsService = new aws_ecs.FargateService(this, "bastion-service", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      securityGroups: [bastionHostSG],
      desiredCount: 1,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });
    
    ecsService.connections.allowTo(database.connections, ec2.Port.tcp(5432));
    
    // ECS Exec有効化
    const CfnService = ecsService.node.defaultChild as aws_ecs.CfnService
    CfnService.addPropertyOverride("EnableExecuteCommand", true)
    
    
    
    
  }
}
