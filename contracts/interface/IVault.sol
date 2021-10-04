// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IVault {
    function balanceOf(address account) external view returns (int256);

    function getFreeCollateralByRatio(address trader, uint24 ratio) external view returns (int256);

    function getSettlementToken() external returns (address);

    /// @dev cached the settlement token's decimal for gas optimization
    function decimals() external view returns (uint8);

    function getTotalDebt() external view returns (uint256);

    function getClearingHouseConfig() external returns (address);

    function getAccountBalance() external returns (address);

    function getInsuranceFund() external returns (address);

    function getExchange() external returns (address);
}
