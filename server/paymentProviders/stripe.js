import models from '../models';
import * as constants from '../constants/transactions';
import roles from '../constants/roles';
import * as stripe from '../gateways/stripe';
import activities from '../constants/activities';
import config from 'config';

/**
 * Calculates the 1st of next month
 * input: date
 * output: 1st of following month, needs to be in Unix time and in seconds (not ms)
 */
const getSubscriptionTrialEndDate = (originalDate, interval) => {
  const newDate = new Date(originalDate.getTime())
  newDate.setDate(1);
  if (interval === 'month') {
    return Math.floor(newDate.setMonth(newDate.getMonth() + 1) / 1000); // set to 1st of next month
  } else if (interval === 'year') {
    return Math.floor(newDate.setMonth(newDate.getMonth() + 12) / 1000); // set to 1st of next year's same month
  } else {
    return null;
  }
}

export default {

  features: {
    recurring: true,
  },

  processOrder: (order) => {

    const {
      fromCollective,
      toCollective,
      paymentMethod,
      subscription,
      tier
    } = order;

    const user = order.createdByUser;

    let hostStripePlan, hostStripeToken, hostStripeCustomerId;

    /**
     * Get the customerId for the Stripe Account of the Host
     * Or create one using the Stripe token associated with the platform (paymentMethod.token)
     * and saves it under PaymentMethod.data[hostStripeAccount.username]
     * @param {*} hostStripeAccount
     */
    const getOrCreateCustomerIdForHost = (hostStripeAccount) => {
      const data = paymentMethod.data || {};
      data.CustomerIdForHost = data.CustomerIdForHost || {};
      return data.CustomerIdForHost[hostStripeAccount.username] || stripe.createToken(hostStripeAccount, paymentMethod.customerId)
      .then(token => stripe.createCustomer(hostStripeAccount, token.id, {
        email: user.email,
        collective: order.fromCollective.info
      }))
      .then(customer => customer.id)
      .tap(customerId => {
        data.CustomerIdForHost[hostStripeAccount.username] = customerId;
        paymentMethod.data = data;
        paymentMethod.save();
      })
    }

    const createSubscription = (hostStripeAccount) => {
      return stripe.getOrCreatePlan(
        hostStripeAccount,
        {
          interval: subscription.interval,
          amount: order.totalAmount,
          currency: order.currency
        })
        .tap(plan => hostStripePlan = plan)
        // create a customer on the host stripe account
        .then(() => getOrCreateCustomerIdForHost(hostStripeAccount))
        .tap(customerId => {
          hostStripeCustomerId = customerId
        })
        .then(() => stripe.createSubscription(
          hostStripeAccount,
          hostStripeCustomerId,
          {
            plan: hostStripePlan.id,
            application_fee_percent: constants.OC_FEE_PERCENT,
            trial_end: getSubscriptionTrialEndDate(order.createdAt, subscription.interval),
            metadata: {
              from: `${config.host.website}/${fromCollective.slug}`,
              to: `${config.host.website}/${toCollective.slug}`,
              PaymentMethodId: paymentMethod.id
            }
          }))
        .then(stripeSubscription => subscription.update({ stripeSubscriptionId: stripeSubscription.id }))
        .then(subscription => subscription.activate())
        .then(subscription => models.Activity.create({
          type: activities.SUBSCRIPTION_CONFIRMED,
          data: {
            collective: toCollective.minimal,
            user: user.minimal,
            tier,
            subscription
          }
        }));
    };

    /**
     * Returns a Promise with the transaction created
     * Note: we need to create a token for hostStripeAccount because paymentMethod.customerId is a customer of the platform
     * See: Shared Customers: https://stripe.com/docs/connect/shared-customers
     */
    const createChargeAndTransactions = (hostStripeAccount) => {
      let charge;
      return stripe.createCharge(
        hostStripeAccount,
        {
          amount: order.totalAmount,
          currency: order.currency,
          source: hostStripeToken.id,
          description: order.description,
          application_fee: parseInt(order.totalAmount * constants.OC_FEE_PERCENT / 100, 10),
          metadata: {
            from: `${config.host.website}/${order.fromCollective.slug}`,
            to: `${config.host.website}/${order.toCollective.slug}`,
            customerEmail: user.email,
            PaymentMethodId: paymentMethod.id
          }
        })
        .tap(c => charge = c)
        .then(charge => stripe.retrieveBalanceTransaction(
          hostStripeAccount,
          charge.balance_transaction))
        .then(balanceTransaction => {
          // create a transaction
          const fees = stripe.extractFees(balanceTransaction);
          const hostFeePercent = toCollective.hostFeePercent;
          const payload = {
            CreatedByUserId: user.id,
            FromCollectiveId: order.FromCollectiveId,
            ToCollectiveId: toCollective.id,
            paymentMethod
          };
          payload.transaction = {
            type: constants.type.DONATION,
            OrderId: order.id,
            amount: order.totalAmount,
            currency: order.currency,
            txnCurrency: balanceTransaction.currency,
            amountInTxnCurrency: balanceTransaction.amount,
            txnCurrencyFxRate: order.totalAmount / balanceTransaction.amount,
            hostFeeInTxnCurrency: parseInt(balanceTransaction.amount * hostFeePercent / 100, 10),
            platformFeeInTxnCurrency: fees.applicationFee,
            paymentProcessorFeeInTxnCurrency: fees.stripeFee,
            description: order.description,
            data: { charge, balanceTransaction },
          };
          return models.Transaction.createFromPayload(payload);
        });
    };

    let hostStripeAccount, transactions;
    return toCollective.getHostStripeAccount()
      .then(stripeAccount => hostStripeAccount = stripeAccount)

      // get or create a customer under the platform stripe account
      .then(() => paymentMethod.customerId || stripe.createCustomer(
        null,
        paymentMethod.token, {
          email: user.email,
          collective: order.fromCollective.info
        }).then(customer => customer.id))
      .tap(platformCustomerId => {
        if (!paymentMethod.customerId) {
          paymentMethod.customerId = platformCustomerId;
          paymentMethod.update({ customerId: platformCustomerId })
        }
      })

      // create a token for the host stripe account
      .then(() => stripe.createToken(hostStripeAccount, paymentMethod.customerId))
      .tap(token => hostStripeToken = token)

      // both one-time and subscriptions get charged immediately
      .then(() => createChargeAndTransactions(hostStripeAccount))
      .tap(t => transactions = t)

      // if this is a subscription, we create it now on Stripe
      .tap(() => subscription ? createSubscription(hostStripeAccount, subscription, order, paymentMethod, toCollective) : null)

      // add user to the collective
      .tap(() => toCollective.findOrAddUserWithRole(user, roles.BACKER, { CreatedByUserId: user.id, TierId: order.TierId }))

      // Mark order row as processed
      .tap(() => order.update({ processedAt: new Date() }))

      // Mark paymentMethod as confirmed
      .tap(() => paymentMethod.update({confirmedAt: new Date}))

      .then(() => transactions); // make sure we return the transactions created
  }
}
