/**
 * Exact monetary arithmetic using integer cents (minor units) to eliminate
 * IEEE-754 floating-point drift across offline tablets and backend ledger.
 */
export class Money {
  private constructor(private readonly cents: number) {}

  static fromMajor(amount: number): Money {
    if (!Number.isFinite(amount)) {
      throw new Error(`Invalid monetary amount: ${amount}`);
    }
    return new Money(Math.round(amount * 100));
  }

  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents)) {
      throw new Error(`Cents must be an integer, received: ${cents}`);
    }
    return new Money(cents);
  }

  static zero(): Money {
    return new Money(0);
  }

  toCents(): number {
    return this.cents;
  }

  toMajor(): number {
    return this.cents / 100;
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  multiply(factor: number): Money {
    return new Money(Math.round(this.cents * factor));
  }

  percentage(percent: number): Money {
    return new Money(Math.round((this.cents * percent) / 100));
  }

  maxZero(): Money {
    return this.cents < 0 ? Money.zero() : this;
  }

  isGreaterThan(other: Money): boolean {
    return this.cents > other.cents;
  }

  isLessThan(other: Money): boolean {
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}

export function roundMoney(amount: number): number {
  return Money.fromMajor(amount).toMajor();
}

