/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AWSError, Credentials, Service } from 'aws-sdk'
import globals from '../../shared/extensionGlobals'
import * as CodeWhispererClient from './codewhispererclient'
import * as CodeWhispererUserClient from './codewhispereruserclient'
import { SendTelemetryEventRequest } from './codewhispereruserclient'
import { ServiceOptions } from '../../shared/awsClientBuilder'
import { hasVendedIamCredentials } from '../../auth/auth'
import { CodeWhispererSettings } from '../util/codewhispererSettings'
import { PromiseResult } from 'aws-sdk/lib/request'
import { AuthUtil } from '../util/authUtil'
import { isSsoConnection } from '../../auth/connection'
import apiConfig = require('./service-2.json')
import userApiConfig = require('./user-service-2.json')
import { session } from '../util/codeWhispererSession'
import { getLogger } from '../../shared/logger/logger'
import { getClientId, getOptOutPreference, getOperatingSystem } from '../../shared/telemetry/util'
import { extensionVersion, getServiceEnvVarConfig } from '../../shared/vscode/env'
import { DevSettings } from '../../shared/settings'
import { CodeWhispererConfig } from '../models/model'

const keepAliveHeader = 'keep-alive-codewhisperer'

export function getCodewhispererConfig(): CodeWhispererConfig {
    const clientConfig = AuthUtil.instance.regionProfileManager.clientConfig
    return {
        ...DevSettings.instance.getServiceConfig('codewhispererService', clientConfig),

        // Environment variable overrides
        ...getServiceEnvVarConfig('codewhisperer', Object.keys(clientConfig)),
    }
}

export type ProgrammingLanguage = Readonly<
    CodeWhispererClient.ProgrammingLanguage | CodeWhispererUserClient.ProgrammingLanguage
>
export type FileContext = Readonly<CodeWhispererClient.FileContext | CodeWhispererUserClient.FileContext>
export type ListRecommendationsRequest = Readonly<
    CodeWhispererClient.ListRecommendationsRequest | CodeWhispererUserClient.GenerateCompletionsRequest
>
export type GenerateRecommendationsRequest = Readonly<CodeWhispererClient.GenerateRecommendationsRequest>
export type RecommendationsList = CodeWhispererClient.RecommendationsList | CodeWhispererUserClient.Completions
export type ListRecommendationsResponse =
    | CodeWhispererClient.ListRecommendationsResponse
    | CodeWhispererUserClient.GenerateCompletionsResponse
export type GenerateRecommendationsResponse = CodeWhispererClient.GenerateRecommendationsResponse
export type Recommendation = CodeWhispererClient.Recommendation | CodeWhispererUserClient.Completion
export type Completion = CodeWhispererUserClient.Completion
export type Reference = CodeWhispererClient.Reference | CodeWhispererUserClient.Reference
export type References = CodeWhispererClient.References | CodeWhispererUserClient.References
export type CreateUploadUrlRequest = Readonly<
    CodeWhispererClient.CreateUploadUrlRequest | CodeWhispererUserClient.CreateUploadUrlRequest
>
export type CreateCodeScanRequest = Readonly<
    CodeWhispererClient.CreateCodeScanRequest | CodeWhispererUserClient.StartCodeAnalysisRequest
>
export type GetCodeScanRequest = Readonly<
    CodeWhispererClient.GetCodeScanRequest | CodeWhispererUserClient.GetCodeAnalysisRequest
>
export type ListCodeScanFindingsRequest = Readonly<
    CodeWhispererClient.ListCodeScanFindingsRequest | CodeWhispererUserClient.ListCodeAnalysisFindingsRequest
>
export type SupplementalContext = Readonly<
    CodeWhispererClient.SupplementalContext | CodeWhispererUserClient.SupplementalContext
>
// eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
export type ArtifactType = Readonly<CodeWhispererClient.ArtifactType | CodeWhispererUserClient.ArtifactType>
export type ArtifactMap = Readonly<CodeWhispererClient.ArtifactMap | CodeWhispererUserClient.ArtifactMap>
export type ListCodeScanFindingsResponse =
    | CodeWhispererClient.ListCodeScanFindingsResponse
    | CodeWhispererUserClient.ListCodeAnalysisFindingsResponse
export type CreateUploadUrlResponse =
    | CodeWhispererClient.CreateUploadUrlResponse
    | CodeWhispererUserClient.CreateUploadUrlResponse
export type CreateCodeScanResponse =
    | CodeWhispererClient.CreateCodeScanResponse
    | CodeWhispererUserClient.StartCodeAnalysisResponse
export type Import = CodeWhispererUserClient.Import
export type Imports = CodeWhispererUserClient.Imports

export class DefaultCodeWhispererClient {
    private async createSdkClient(): Promise<CodeWhispererClient> {
        const isOptedOut = CodeWhispererSettings.instance.isOptoutEnabled()
        const cwsprConfig = getCodewhispererConfig()
        return (await globals.sdkClientBuilder.createAwsService(
            Service,
            {
                apiConfig: apiConfig,
                region: cwsprConfig.region,
                credentials: await AuthUtil.instance.getCredentials(),
                endpoint: cwsprConfig.endpoint,
                onRequestSetup: [
                    (req) => {
                        if (req.operation === 'listRecommendations') {
                            req.on('build', () => {
                                req.httpRequest.headers['x-amzn-codewhisperer-optout'] = `${isOptedOut}`
                            })
                        }
                        // This logic is for backward compatability with legacy SDK v2 behavior for refreshing
                        // credentials. Once the Toolkit adds a file watcher for credentials it won't be needed.

                        if (hasVendedIamCredentials()) {
                            req.on('retry', (resp) => {
                                if (
                                    resp.error?.code === 'AccessDeniedException' &&
                                    resp.error.message.match(/expired/i)
                                ) {
                                    AuthUtil.instance.reauthenticate().catch((e) => {
                                        getLogger().error('reauthenticate failed: %s', (e as Error).message)
                                    })
                                    resp.error.retryable = true
                                }
                            })
                        }
                    },
                ],
            } as ServiceOptions,
            undefined
        )) as CodeWhispererClient
    }

    async createUserSdkClient(maxRetries?: number): Promise<CodeWhispererUserClient> {
        const isOptedOut = CodeWhispererSettings.instance.isOptoutEnabled()
        session.setFetchCredentialStart()
        const bearerToken = await AuthUtil.instance.getBearerToken()
        session.setSdkApiCallStart()
        const cwsprConfig = getCodewhispererConfig()
        return (await globals.sdkClientBuilder.createAwsService(
            Service,
            {
                apiConfig: userApiConfig,
                region: cwsprConfig.region,
                endpoint: cwsprConfig.endpoint,
                maxRetries: maxRetries,
                credentials: new Credentials({ accessKeyId: 'xxx', secretAccessKey: 'xxx' }),
                onRequestSetup: [
                    (req) => {
                        req.on('build', ({ httpRequest }) => {
                            httpRequest.headers['Authorization'] = `Bearer ${bearerToken}`
                        })
                        if (req.operation === 'generateCompletions') {
                            req.on('build', () => {
                                req.httpRequest.headers['x-amzn-codewhisperer-optout'] = `${isOptedOut}`
                                req.httpRequest.headers['Connection'] = keepAliveHeader
                            })
                        }
                    },
                ],
            } as ServiceOptions,
            undefined
        )) as CodeWhispererUserClient
    }

    private isBearerTokenAuth(): boolean {
        return isSsoConnection(AuthUtil.instance.conn)
    }

    public async generateRecommendations(
        request: GenerateRecommendationsRequest
    ): Promise<GenerateRecommendationsResponse> {
        return (await this.createSdkClient()).generateRecommendations(request).promise()
    }

    public async listRecommendations(request: ListRecommendationsRequest): Promise<ListRecommendationsResponse> {
        if (this.isBearerTokenAuth()) {
            return await (await this.createUserSdkClient()).generateCompletions(request).promise()
        }
        return (await this.createSdkClient()).listRecommendations(request).promise()
    }

    public async createUploadUrl(
        request: CreateUploadUrlRequest
    ): Promise<PromiseResult<CreateUploadUrlResponse, AWSError>> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).createUploadUrl(request).promise()
        }
        return (await this.createSdkClient()).createCodeScanUploadUrl(request).promise()
    }

    public async createCodeScan(
        request: CreateCodeScanRequest
    ): Promise<PromiseResult<CreateCodeScanResponse, AWSError>> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).startCodeAnalysis(request).promise()
        }
        return (await this.createSdkClient()).createCodeScan(request).promise()
    }

    public async getCodeScan(
        request: GetCodeScanRequest
    ): Promise<PromiseResult<CodeWhispererClient.GetCodeScanResponse, AWSError>> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).getCodeAnalysis(request).promise()
        }
        return (await this.createSdkClient()).getCodeScan(request).promise()
    }

    public async listCodeScanFindings(
        request: ListCodeScanFindingsRequest,
        profileArn: string | undefined
    ): Promise<PromiseResult<ListCodeScanFindingsResponse, AWSError>> {
        if (this.isBearerTokenAuth()) {
            const req = {
                jobId: request.jobId,
                nextToken: request.nextToken,
                codeAnalysisFindingsSchema: 'codeanalysis/findings/1.0',
                profileArn: profileArn,
            } as CodeWhispererUserClient.ListCodeAnalysisFindingsRequest
            return (await this.createUserSdkClient()).listCodeAnalysisFindings(req).promise()
        }
        return (await this.createSdkClient())
            .listCodeScanFindings(request as CodeWhispererClient.ListCodeScanFindingsRequest)
            .promise()
    }

    public async sendTelemetryEvent(request: SendTelemetryEventRequest) {
        const requestWithCommonFields: SendTelemetryEventRequest = {
            ...request,
            optOutPreference: getOptOutPreference(),
            userContext: {
                ideCategory: 'VSCODE',
                operatingSystem: getOperatingSystem(),
                product: 'CodeWhisperer', // TODO: update this?
                clientId: getClientId(globals.globalState),
                ideVersion: extensionVersion,
            },
            profileArn: AuthUtil.instance.regionProfileManager.activeRegionProfile?.arn,
        }
        if (!AuthUtil.instance.isValidEnterpriseSsoInUse() && !globals.telemetry.telemetryEnabled) {
            return
        }
        const response = await (await this.createUserSdkClient()).sendTelemetryEvent(requestWithCommonFields).promise()
        getLogger().debug(`codewhisperer: sendTelemetryEvent requestID: ${response.$response.requestId}`)
    }

    /**
     * @description Use this function to start the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */
    public async codeModernizerStartCodeTransformation(
        request: CodeWhispererUserClient.StartTransformationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.StartTransformationResponse, AWSError>> {
        return (await this.createUserSdkClient()).startTransformation(request).promise()
    }

    /**
     * @description Use this function to stop the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */
    public async codeModernizerStopCodeTransformation(
        request: CodeWhispererUserClient.StopTransformationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.StopTransformationResponse, AWSError>> {
        return (await this.createUserSdkClient()).stopTransformation(request).promise()
    }

    /**
     * @description Use this function to get the status of the code transformation. We should
     * be polling this function periodically to get updated results. When this function
     * returns PARTIALLY_COMPLETED or COMPLETED we know the transformation is done.
     */
    public async codeModernizerGetCodeTransformation(
        request: CodeWhispererUserClient.GetTransformationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.GetTransformationResponse, AWSError>> {
        // instead of the default of 3 retries, use 8 retries for this API which is polled every 5 seconds
        return (await this.createUserSdkClient(8)).getTransformation(request).promise()
    }

    /**
     * @description During client-side build, or after the job has been PAUSED we need to get user intervention.
     * Once that user action has been handled we can resume the transformation job.
     * @params transformationJobId - String id returned from StartCodeTransformationResponse
     * @params userActionStatus - String to determine what action the user took, if any.
     */
    public async codeModernizerResumeTransformation(
        request: CodeWhispererUserClient.ResumeTransformationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.ResumeTransformationResponse, AWSError>> {
        return (await this.createUserSdkClient(8)).resumeTransformation(request).promise()
    }

    /**
     * @description After starting a transformation use this function to display the LLM
     * transformation plan to the user.
     * @params transformationJobId - String id returned from StartCodeTransformationResponse
     */
    public async codeModernizerGetCodeTransformationPlan(
        request: CodeWhispererUserClient.GetTransformationPlanRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.GetTransformationPlanResponse, AWSError>> {
        // instead of the default of 3 retries, use 8 retries for this API which is polled every 5 seconds
        return (await this.createUserSdkClient(8)).getTransformationPlan(request).promise()
    }

    public async startCodeFixJob(
        request: CodeWhispererUserClient.StartCodeFixJobRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.StartCodeFixJobResponse, AWSError>> {
        return (await this.createUserSdkClient()).startCodeFixJob(request).promise()
    }

    public async getCodeFixJob(
        request: CodeWhispererUserClient.GetCodeFixJobRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.GetCodeFixJobResponse, AWSError>> {
        return (await this.createUserSdkClient()).getCodeFixJob(request).promise()
    }

    public async startTestGeneration(
        request: CodeWhispererUserClient.StartTestGenerationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.StartTestGenerationResponse, AWSError>> {
        return (await this.createUserSdkClient()).startTestGeneration(request).promise()
    }

    public async getTestGeneration(
        request: CodeWhispererUserClient.GetTestGenerationRequest
    ): Promise<PromiseResult<CodeWhispererUserClient.GetTestGenerationResponse, AWSError>> {
        return (await this.createUserSdkClient()).getTestGeneration(request).promise()
    }
}

export const codeWhispererClient = new DefaultCodeWhispererClient()

export class CognitoCredentialsError extends Error {}
