import { ethers } from "hardhat"
import { TestERC20, Vault } from "../../typechain"

interface VaultFixture {
    vault: Vault
    USDC: TestERC20
}

export function createVaultFixture(): () => Promise<VaultFixture> {
    return async (): Promise<VaultFixture> => {
        // deploy test tokens
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        const USDC = (await tokenFactory.deploy("TestUSDC", "USDC")) as TestERC20

        const vaultFactory = await ethers.getContractFactory("Vault")
        const vault = (await vaultFactory.deploy(USDC.address)) as Vault
        return { vault, USDC }
    }
}
