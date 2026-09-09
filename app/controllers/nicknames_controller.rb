# The join screen offers players a name rather than letting them invent one.
class NicknamesController < ApplicationController
  def show
    render json: { name: Tigerquiz::Nicknames.suggest }
  end
end
